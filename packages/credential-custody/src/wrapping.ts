import {
  createECDH,
  createDecipheriv,
  createHash,
  randomUUID,
  randomBytes,
} from 'node:crypto';

/**
 * Design spec §2.2 — Mode 1 intake, steps 1–5.
 *
 * The browser wraps the secret before it leaves the tab. This sounds paranoid
 * until you consider the realistic failure: someone enables request-body
 * logging on an ingress controller for an afternoon, and six months of
 * customer API keys are in a log aggregator with a different retention policy
 * and a different access list.
 *
 * Client-side wrapping makes that class of incident structurally impossible
 * rather than procedurally discouraged.
 *
 * Curve: P-256, matching WebCrypto's ECDH support in every target browser.
 */

const CURVE = 'prime256v1';
const WRAPPING_KEY_TTL_SECONDS = 120;

export interface WrappingKeyRecord {
  readonly kid: string;
  readonly privateKey: Buffer;
  readonly publicKeyRaw: Buffer;
  readonly expiresAt: number;
}

/** What the browser receives. The private half never leaves the custody service. */
export interface PublishedWrappingKey {
  readonly kid: string;
  readonly publicJwk: {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string;
    readonly y: string;
  };
  readonly expiresAt: string;
  readonly algorithm: 'ECDH-ES+A256GCM';
}

/** What the browser sends back. Nothing here is readable without the private half. */
export interface WrappedSecretEnvelope {
  readonly kid: string;
  /** Sender's ephemeral public key, raw uncompressed point, base64url. */
  readonly epk: string;
  /** 12-byte GCM IV, base64url. */
  readonly iv: string;
  /** Ciphertext, base64url. */
  readonly ct: string;
  /** 16-byte GCM auth tag, base64url. */
  readonly tag: string;
}

function b64u(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/**
 * In-memory, TTL-bounded wrapping key store.
 *
 * Deliberately in-memory: a wrapping key that outlives the process, or that is
 * shared across pods through a datastore, is a wrapping key that can be
 * exfiltrated at rest. A two-minute TTL and a single-pod lifetime is the point.
 */
export class WrappingKeyStore {
  private readonly keys = new Map<string, WrappingKeyRecord>();
  private readonly ttlSeconds: number;

  constructor(ttlSeconds: number = WRAPPING_KEY_TTL_SECONDS) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
      throw new Error('wrapping key TTL must be between 30 and 300 seconds');
    }
    this.ttlSeconds = ttlSeconds;
  }

  issue(now: number = Date.now()): PublishedWrappingKey {
    this.evictExpired(now);

    const ecdh = createECDH(CURVE);
    ecdh.generateKeys();
    const publicKeyRaw = ecdh.getPublicKey();
    const kid = randomUUID();
    const expiresAt = now + this.ttlSeconds * 1000;

    this.keys.set(kid, {
      kid,
      privateKey: ecdh.getPrivateKey(),
      publicKeyRaw,
      expiresAt,
    });

    // Raw uncompressed point: 0x04 || X(32) || Y(32)
    return {
      kid,
      publicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: b64u(publicKeyRaw.subarray(1, 33)),
        y: b64u(publicKeyRaw.subarray(33, 65)),
      },
      expiresAt: new Date(expiresAt).toISOString(),
      algorithm: 'ECDH-ES+A256GCM',
    };
  }

  /**
   * Unwraps to plaintext in memory. The caller MUST zeroise the returned
   * buffer (see `zeroise`) once the secret has been probed and written to the
   * vault. The wrapping key is consumed: one envelope per key, no replay.
   */
  unwrap(envelope: WrappedSecretEnvelope, now: number = Date.now()): Buffer {
    const record = this.keys.get(envelope.kid);
    if (record === undefined) {
      throw new Error('CUSTODY_WRAPPING_KEY_UNKNOWN');
    }
    // Single use, regardless of outcome.
    this.keys.delete(envelope.kid);

    if (record.expiresAt <= now) {
      zeroise(record.privateKey);
      throw new Error('CUSTODY_WRAPPING_KEY_EXPIRED');
    }

    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(record.privateKey);

    let shared: Buffer;
    try {
      shared = ecdh.computeSecret(unb64u(envelope.epk));
    } catch {
      zeroise(record.privateKey);
      throw new Error('CUSTODY_UNWRAP_FAILED');
    }

    // Concat KDF (NIST SP 800-56A, single round is sufficient for a 32-byte key).
    const aesKey = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), shared, Buffer.from('ECDH-ES+A256GCM', 'utf8')]))
      .digest();

    zeroise(shared);
    zeroise(record.privateKey);

    try {
      const decipher = createDecipheriv('aes-256-gcm', aesKey, unb64u(envelope.iv));
      decipher.setAuthTag(unb64u(envelope.tag));
      const plaintext = Buffer.concat([decipher.update(unb64u(envelope.ct)), decipher.final()]);
      zeroise(aesKey);
      return plaintext;
    } catch {
      zeroise(aesKey);
      throw new Error('CUSTODY_UNWRAP_FAILED');
    }
  }

  evictExpired(now: number = Date.now()): number {
    let evicted = 0;
    for (const [kid, record] of this.keys) {
      if (record.expiresAt <= now) {
        zeroise(record.privateKey);
        this.keys.delete(kid);
        evicted += 1;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.keys.size;
  }
}

/**
 * Overwrites a buffer in place. Not a guarantee against a determined attacker
 * with memory access, but it removes the window in which a heap dump or a
 * core file contains the secret, which is the realistic exposure.
 */
export function zeroise(buffer: Buffer): void {
  randomBytes(buffer.length).copy(buffer);
  buffer.fill(0);
}
