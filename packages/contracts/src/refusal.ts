/**
 * Typed refusal codes used across the hub, matching plan V3.1 §Integration hub §Contract
 * ("a refusal is a typed result with a reason and a trace ID, never an exception").
 *
 * These are stable identifiers. Add new codes with a new string literal; never repurpose
 * an existing one. Every refusal carries a traceId; the hub never reveals which internal
 * check failed beyond what these codes encode.
 */
export type RefusalCode =
  // Scope-token verification
  | 'TOKEN_SIGNATURE_INVALID'
  | 'TOKEN_MALFORMED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_YET_VALID'
  | 'TOKEN_WRONG_ISSUER'
  | 'TOKEN_WRONG_AUDIENCE'
  | 'TOKEN_SCOPE_MISMATCH'
  // Credential classes (plan rule 5)
  | 'CREDENTIAL_NOT_GRANTED'
  | 'CREDENTIAL_CLASS_FORBIDDEN'
  | 'NO_KEY_FALLBACK'
  // Residency (plan rule 6)
  | 'TENANT_WRONG_REGION'
  // Request shape
  | 'IDEMPOTENCY_REPLAY'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_REPLAY'
  // Downstream (business rule said no, distinct from retryable transport failure)
  | 'REFUSED';

export interface Refusal<Code extends RefusalCode = RefusalCode> {
  readonly ok: false;
  readonly code: Code;
  readonly traceId: string;
  readonly message?: string;
}

export const refusal = <Code extends RefusalCode>(code: Code, traceId: string, message?: string): Refusal<Code> => {
  const base = { ok: false as const, code, traceId };
  return message === undefined ? base : { ...base, message };
};

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
    && typeof (value as { code?: unknown }).code === 'string';
