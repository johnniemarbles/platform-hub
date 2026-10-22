/**
 * Scope tokens are short-lived, signed credentials that platform-core mints and
 * platform-hub verifies on every /v1 call. They name exactly what the holder may
 * do: user or workload, tenant, app, permissions, hierarchy scope, credential
 * class and (optionally) which specific credential grant is in play.
 *
 * The hub never consults its own copy of roles; the signed token IS the authority
 * for one request (plan V3.1 §Authorization between layers). A verifier that
 * accepts a token issued to another tenant, app, or credential class is a bug.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { refusal, type Refusal, type RefusalCode } from './refusal.ts';

/** Credential classes from plan rule 5. */
export type CredentialClass = 'platform-operational' | 'tenant-byok' | 'platform-provisioned';

export type SubjectKind = 'user' | 'workload';

export interface ScopeTokenClaims {
  readonly iss: string;                 // 'platform'
  readonly aud: string;                 // 'hub'
  readonly sub: string;                 // user id or workload id
  readonly kind: SubjectKind;
  readonly tenantId: string;
  readonly appId: string;
  readonly permissions: readonly string[];
  readonly hierarchyScope: string;      // node id; implicit "everything below"
  readonly credentialClass: CredentialClass;
  readonly grantId?: string;            // required when credentialClass !== 'platform-operational'
  readonly jti: string;                 // for replay tracking
  readonly iat: number;                 // seconds
  readonly nbf?: number;                // seconds
  readonly exp: number;                 // seconds
}

export interface VerifyOptions {
  readonly secret: string;
  readonly expectedIssuer?: string;     // default 'platform'
  readonly expectedAudience?: string;   // default 'hub'
  readonly now?: () => Date;
  readonly traceId: string;             // caller supplies to carry through refusals and logs
}

export interface Verified {
  readonly ok: true;
  readonly claims: ScopeTokenClaims;
}

export type VerifyResult = Verified | Refusal;

const base64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64urlDecode = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
};

const refuseWith = <C extends RefusalCode>(code: C, traceId: string): Refusal<C> => refusal(code, traceId);

/** Minimum-size HMAC secret enforced on both signer and verifier. */
export const SCOPE_TOKEN_SECRET_MIN_BYTES = 32;

/** Sign a scope token (HS256). Platform-core calls this; the hub never does. */
export function signScopeToken(claims: ScopeTokenClaims, secret: string): string {
  if (secret.length < SCOPE_TOKEN_SECRET_MIN_BYTES) {
    throw new Error(`scope-token secret must be at least ${SCOPE_TOKEN_SECRET_MIN_BYTES} bytes`);
  }
  if (claims.credentialClass !== 'platform-operational' && claims.grantId === undefined) {
    throw new Error('scope-token: grantId is required when credentialClass is tenant-byok or platform-provisioned');
  }
  const header = { alg: 'HS256', typ: 'SCOPE' };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(claims));
  const sig = base64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

/** Verify a scope token. Returns a typed result; never throws on business failure. */
export function verifyScopeToken(token: string, options: VerifyOptions): VerifyResult {
  const trace = options.traceId;
  if (options.secret.length < SCOPE_TOKEN_SECRET_MIN_BYTES) {
    throw new Error('scope-token: verifier secret too short');
  }
  const parts = token.split('.');
  if (parts.length !== 3) return refuseWith('TOKEN_MALFORMED', trace);
  const [h, p, s] = parts as [string, string, string];

  // Constant-time signature compare
  const expected = base64url(createHmac('sha256', options.secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuseWith('TOKEN_SIGNATURE_INVALID', trace);

  let header: { alg?: unknown; typ?: unknown };
  let claims: ScopeTokenClaims;
  try {
    header = JSON.parse(base64urlDecode(h).toString('utf8'));
    claims = JSON.parse(base64urlDecode(p).toString('utf8')) as ScopeTokenClaims;
  } catch {
    return refuseWith('TOKEN_MALFORMED', trace);
  }
  if (header.alg !== 'HS256' || header.typ !== 'SCOPE') return refuseWith('TOKEN_MALFORMED', trace);

  // Shape check
  const required: Array<keyof ScopeTokenClaims> = ['iss', 'aud', 'sub', 'kind', 'tenantId', 'appId', 'permissions', 'hierarchyScope', 'credentialClass', 'jti', 'iat', 'exp'];
  for (const k of required) if (claims[k] === undefined) return refuseWith('TOKEN_MALFORMED', trace);
  if (!Array.isArray(claims.permissions)) return refuseWith('TOKEN_MALFORMED', trace);
  if (claims.kind !== 'user' && claims.kind !== 'workload') return refuseWith('TOKEN_MALFORMED', trace);
  if (!['platform-operational', 'tenant-byok', 'platform-provisioned'].includes(claims.credentialClass)) return refuseWith('TOKEN_MALFORMED', trace);
  if (claims.credentialClass !== 'platform-operational' && claims.grantId === undefined) return refuseWith('TOKEN_MALFORMED', trace);

  if (claims.iss !== (options.expectedIssuer ?? 'platform')) return refuseWith('TOKEN_WRONG_ISSUER', trace);
  if (claims.aud !== (options.expectedAudience ?? 'hub')) return refuseWith('TOKEN_WRONG_AUDIENCE', trace);

  const nowSec = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (claims.nbf !== undefined && nowSec < claims.nbf) return refuseWith('TOKEN_NOT_YET_VALID', trace);
  if (nowSec >= claims.exp) return refuseWith('TOKEN_EXPIRED', trace);

  return { ok: true as const, claims };
}

/**
 * Enforces scope on a verified token for a specific request. Call this after
 * verifyScopeToken(): it refuses when the token's tenant, app, hierarchy or
 * credential class does not cover the resource being touched.
 */
export interface ScopeCheck {
  readonly tenantId: string;
  readonly appId: string;
  readonly hierarchyNode?: string;         // the specific node the request names
  readonly permission?: string;            // the permission key the request needs
  readonly credentialClass?: CredentialClass;
  readonly grantId?: string;               // when operating on a specific grant
}

export function enforceScope(verified: Verified, check: ScopeCheck, traceId: string): true | Refusal {
  const c = verified.claims;
  if (c.tenantId !== check.tenantId) return refuseWith('TOKEN_SCOPE_MISMATCH', traceId);
  if (c.appId !== check.appId) return refuseWith('TOKEN_SCOPE_MISMATCH', traceId);
  if (check.permission !== undefined && !c.permissions.includes(check.permission)) {
    return refuseWith('TOKEN_SCOPE_MISMATCH', traceId);
  }
  if (check.hierarchyNode !== undefined
      && check.hierarchyNode !== c.hierarchyScope
      && !check.hierarchyNode.startsWith(`${c.hierarchyScope}/`)) {
    return refuseWith('TOKEN_SCOPE_MISMATCH', traceId);
  }
  if (check.credentialClass !== undefined && check.credentialClass !== c.credentialClass) {
    return refuseWith('CREDENTIAL_CLASS_FORBIDDEN', traceId);
  }
  if (check.grantId !== undefined && check.grantId !== c.grantId) {
    return refuseWith('CREDENTIAL_NOT_GRANTED', traceId);
  }
  return true;
}
