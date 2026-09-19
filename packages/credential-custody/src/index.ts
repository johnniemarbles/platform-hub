/**
 * @platform-hub/credential-custody
 *
 * Design spec §2 — the custody ladder, and §3.2 — trust boundaries.
 * This is the ONLY package permitted to hold a plaintext provider credential,
 * and only in memory, for the duration of one intake operation.
 */

export * from './fingerprint.ts';
export * from './wrapping.ts';
export * from './probe.ts';
export { probeFor as resolveCredentialProbe } from './probe-dispatch.ts';
export { LLM_COMPAT_PROBES, anthropicProbe } from './llm-probes.ts';
export * from './secret-vault.ts';
export * from './intake.ts';
export * from './revocation.ts';
export * from './custody-ticket.ts';

export type CustodyMode =
  | 'PLATFORM_MANAGED'
  | 'DELEGATED'
  | 'CUSTOMER_REFERENCED'
  | 'CUSTOMER_EGRESS';

export type CredentialFailurePolicy =
  | 'HOLD_AND_RETRY'
  | 'FALLBACK_TRANSACTIONAL'
  | 'REFUSE_IMMEDIATELY';

export type CredentialProbeStatus = 'VALID' | 'FAILING' | 'INVALID';

export type CredentialState =
  | 'PENDING_PROBE'
  | 'ACTIVE'
  | 'FAILING'
  | 'INVALID'
  | 'REVOKED'
  | 'SUPERSEDED';

export type CustodyErrorCode =
  | 'CUSTODY_WRAPPING_KEY_EXPIRED'
  | 'CUSTODY_WRAPPING_KEY_UNKNOWN'
  | 'CUSTODY_UNWRAP_FAILED'
  | 'CUSTODY_PROBE_FAILED'
  | 'CUSTODY_PROVIDER_UNSUPPORTED'
  | 'CUSTODY_VAULT_WRITE_FAILED'
  | 'CUSTODY_PAYLOAD_INVALID';

export class CustodyError extends Error {
  readonly code: CustodyErrorCode;
  constructor(code: CustodyErrorCode, message: string) {
    super(message);
    this.name = 'CustodyError';
    this.code = code;
  }
}

export function custodyModeIsAvailable(
  mode: CustodyMode,
  enabled: readonly CustodyMode[],
): boolean {
  return enabled.includes(mode);
}

export function failurePolicyPermitsFallback(input: {
  readonly policy: CredentialFailurePolicy;
  readonly purpose: 'transactional' | 'marketing' | 'system';
  readonly residencyPinned: boolean;
}): boolean {
  if (input.policy !== 'FALLBACK_TRANSACTIONAL') return false;
  if (input.residencyPinned) return false;
  return input.purpose !== 'marketing';
}
