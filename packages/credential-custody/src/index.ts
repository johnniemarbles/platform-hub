/**
 * @platform-hub/credential-custody
 *
 * Design spec §2 — the custody ladder, and §3.2 — trust boundaries.
 *
 * This is the ONLY package in the monorepo permitted to hold a plaintext
 * provider credential, and only in memory, for the duration of one intake
 * operation. It has no database client in its dependency graph by design;
 * a CI test asserts that (§12, security gate 3).
 *
 * Nothing here may be imported by the control-plane API tier.
 */

export * from './fingerprint.js';
export * from './wrapping.js';
export * from './probe.js';
export * from './secret-vault.js';
export * from './intake.js';

/** §2.1 — the four trust postures. Not one capability; four. */
export type CustodyMode =
  /** Mode 0 — tenant sends on platform connectors. Zero setup, shared reputation. */
  | 'PLATFORM_MANAGED'
  /** Mode 1 — tenant pastes a key, EXPADIO escrows it in KMS/Vault. */
  | 'DELEGATED'
  /** Mode 2 — EXPADIO assumes a role into the customer's own secret store. */
  | 'CUSTOMER_REFERENCED'
  /** Mode 3 — provider calls originate in the customer's VPC. EXPADIO holds nothing. */
  | 'CUSTOMER_EGRESS';

/** §2.5 — chosen at setup, never during an incident (commitment C-4). */
export type CredentialFailurePolicy =
  | 'HOLD_AND_RETRY'
  | 'FALLBACK_TRANSACTIONAL'
  | 'REFUSE_IMMEDIATELY';

/** §2.7 — continuous credential health. */
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

/**
 * §2.1 — modes ship in order. D1: Modes 0 and 1 in v1, Mode 2 in the
 * following release, Mode 3 only against a contract that funds it.
 */
export function custodyModeIsAvailable(
  mode: CustodyMode,
  enabled: readonly CustodyMode[],
): boolean {
  return enabled.includes(mode);
}

/**
 * §2.5 — the fallback option is channel-and-purpose-scoped by construction.
 * Marketing can never inherit platform reputation through a failure path
 * (BEMP C5, target architecture §5.3). Residency pins disable it entirely.
 */
export function failurePolicyPermitsFallback(input: {
  readonly policy: CredentialFailurePolicy;
  readonly purpose: 'transactional' | 'marketing' | 'system';
  readonly residencyPinned: boolean;
}): boolean {
  if (input.policy !== 'FALLBACK_TRANSACTIONAL') return false;
  if (input.residencyPinned) return false;
  return input.purpose !== 'marketing';
}
export * from './revocation.js';
