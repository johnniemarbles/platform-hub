/**
 * Ed25519 scope tokens — the production algorithm.
 *
 * In production the platform signs with its ed25519 private key, which lives
 * only on platform-core; the hub holds the matching public key and verifies
 * with it. A hub compromise can read tokens but cannot mint them. Compare with
 * the HS256 variant in ./scope-token.ts, used for Gate 1 dev.
 *
 * Both algorithms share the same claim shape (ScopeTokenClaims) and the same
 * `enforceScope` check downstream, so switching from HS256 to Ed25519 is a
 * signer + verifier swap, not a protocol change.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { refusal, type Refusal } from './refusal.ts';
import type { ScopeTokenClaims, Verified, VerifyResult } from './scope-token.ts';

const base64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64urlDecode = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
};

export interface Ed25519SignerOptions {
  readonly privateKey: KeyObject | string;   // PEM string or KeyObject
}

export interface Ed25519VerifierOptions {
  readonly publicKey: KeyObject | string;    // PEM string or KeyObject
  readonly expectedIssuer?: string;
  readonly expectedAudience?: string;
  readonly now?: () => Date;
  readonly traceId: string;
}

const toPrivateKey = (k: KeyObject | string): KeyObject =>
  typeof k === 'string' ? createPrivateKey(k) : k;
const toPublicKey = (k: KeyObject | string): KeyObject =>
  typeof k === 'string' ? createPublicKey(k) : k;

export function signScopeTokenEd25519(claims: ScopeTokenClaims, options: Ed25519SignerOptions): string {
  const key = toPrivateKey(options.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('privateKey must be Ed25519');
  if (claims.credentialClass !== 'platform-operational' && claims.grantId === undefined) {
    throw new Error('scope-token: grantId is required when credentialClass is tenant-byok or platform-provisioned');
  }
  const header = { alg: 'EdDSA', crv: 'Ed25519', typ: 'SCOPE' };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(claims));
  const sig = base64url(sign(null, Buffer.from(`${h}.${p}`), key));
  return `${h}.${p}.${sig}`;
}

export function verifyScopeTokenEd25519(token: string, options: Ed25519VerifierOptions): VerifyResult {
  const trace = options.traceId;
  const key = toPublicKey(options.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('publicKey must be Ed25519');

  const parts = token.split('.');
  if (parts.length !== 3) return refusal('TOKEN_MALFORMED', trace);
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: unknown; crv?: unknown; typ?: unknown };
  let claims: ScopeTokenClaims;
  try {
    header = JSON.parse(base64urlDecode(h).toString('utf8'));
    claims = JSON.parse(base64urlDecode(p).toString('utf8')) as ScopeTokenClaims;
  } catch { return refusal('TOKEN_MALFORMED', trace); }
  if (header.alg !== 'EdDSA' || header.crv !== 'Ed25519' || header.typ !== 'SCOPE') {
    return refusal('TOKEN_MALFORMED', trace);
  }

  const sigBytes = base64urlDecode(s);
  if (sigBytes.length !== 64) return refusal('TOKEN_MALFORMED', trace);
  const ok = verify(null, Buffer.from(`${h}.${p}`), key, sigBytes);
  if (!ok) return refusal('TOKEN_SIGNATURE_INVALID', trace);

  // Same shape and expiry checks as HS256 (duplicated to keep the two
  // verifiers independent — one must never fall through to the other).
  const required: Array<keyof ScopeTokenClaims> = ['iss', 'aud', 'sub', 'kind', 'tenantId', 'appId', 'permissions', 'hierarchyScope', 'credentialClass', 'jti', 'iat', 'exp'];
  for (const k of required) if (claims[k] === undefined) return refusal('TOKEN_MALFORMED', trace);
  if (!Array.isArray(claims.permissions)) return refusal('TOKEN_MALFORMED', trace);
  if (claims.credentialClass !== 'platform-operational' && claims.grantId === undefined) {
    return refusal('TOKEN_MALFORMED', trace);
  }
  if (claims.iss !== (options.expectedIssuer ?? 'platform')) return refusal('TOKEN_WRONG_ISSUER', trace);
  if (claims.aud !== (options.expectedAudience ?? 'hub')) return refusal('TOKEN_WRONG_AUDIENCE', trace);

  const nowSec = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (claims.nbf !== undefined && nowSec < claims.nbf) return refusal('TOKEN_NOT_YET_VALID', trace);
  if (nowSec >= claims.exp) return refusal('TOKEN_EXPIRED', trace);

  const result: Verified = { ok: true as const, claims };
  return result;
}
