import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Design spec §2.3 — fingerprints.
 *
 * BEMP prohibition C1 bans partial masking, and masking (SK…a91f) discloses
 * key material. But a tenant with three Twilio subaccounts genuinely needs to
 * know which key is installed.
 *
 * HMAC, not a bare hash: the value cannot be precomputed against a dictionary
 * even for a low-entropy secret. Zero bits of the secret are disclosed.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish; no I/O/0/1.

/**
 * @param secret        the plaintext credential. Never persisted, never logged.
 * @param fingerprintKey a platform-wide HMAC key, distinct from any encryption
 *                       key, rotated independently. Read from
 *                       CUSTODY_FINGERPRINT_KEY (64 hex chars).
 * @returns "K7QM-2F9X"
 */
export function credentialFingerprint(secret: string, fingerprintKey: Buffer): string {
  if (secret.length === 0) {
    throw new Error('cannot fingerprint an empty secret');
  }
  if (fingerprintKey.length < 32) {
    throw new Error('fingerprint key must be at least 32 bytes');
  }

  const digest = createHmac('sha256', fingerprintKey).update(secret, 'utf8').digest();

  let out = '';
  for (let i = 0; i < 8; i += 1) {
    const byte = digest[i] ?? 0;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function parseFingerprintKey(hex: string | undefined): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CUSTODY_FINGERPRINT_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * §2.3 — the same fingerprint under two tenants is either a shared provider
 * account (a billing and blast-radius problem) or a credential leak.
 * Neither should be silent.
 */
export interface FingerprintCollision {
  readonly fingerprint: string;
  readonly tenantIds: readonly string[];
  readonly connectorKeys: readonly string[];
}

export function detectFingerprintCollisions(
  rows: readonly { readonly fingerprint: string; readonly tenantId: string; readonly connectorKey: string }[],
): readonly FingerprintCollision[] {
  const byFingerprint = new Map<string, { tenants: Set<string>; connectors: Set<string> }>();

  for (const row of rows) {
    const entry = byFingerprint.get(row.fingerprint) ?? { tenants: new Set(), connectors: new Set() };
    entry.tenants.add(row.tenantId);
    entry.connectors.add(row.connectorKey);
    byFingerprint.set(row.fingerprint, entry);
  }

  const collisions: FingerprintCollision[] = [];
  for (const [fingerprint, entry] of byFingerprint) {
    if (entry.tenants.size > 1) {
      collisions.push({
        fingerprint,
        tenantIds: [...entry.tenants].sort(),
        connectorKeys: [...entry.connectors].sort(),
      });
    }
  }
  return collisions;
}
