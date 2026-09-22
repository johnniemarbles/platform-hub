import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class CustodyFingerprintKeyError extends Error {
  readonly code = 'CUSTODY_FINGERPRINT_KEY_MISSING';
  constructor() {
    super('Credential vault is not configured on this environment. Set CUSTODY_FINGERPRINT_KEY on brand-web and platform-web (64 hex characters, or any long passphrase).');
    this.name = 'CustodyFingerprintKeyError';
  }
}

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

/** 64-char hex is used as-is. Any other non-empty value is SHA-256’d to 32 bytes. */
export function parseFingerprintKey(hex: string | undefined): Buffer {
  const raw = typeof hex === 'string' ? hex.trim() : '';
  if (raw === '') {
    throw new CustodyFingerprintKeyError();
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

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
