import type {
  CredentialLease,
  CredentialLeaseIssuer,
  CredentialLeaseIssuerInput,
} from './credential-access.ts';

export const SEND_CREDENTIAL_LEASE_TTL_SECONDS = 60;

export interface ShortLivedCredentialLeaseIssuerOptions {
  /** Send-path TTL. Must be 1..60 seconds; a stricter service maximum still wins. */
  readonly ttlSeconds?: number;
  readonly now?: () => string;
  readonly leaseId?: () => string;
  readonly auditId?: () => string;
}

export class ShortLivedCredentialLeaseIssuer implements CredentialLeaseIssuer {
  readonly #ttlSeconds: number;
  readonly #now: () => string;
  readonly #leaseId: () => string;
  readonly #auditId: () => string;

  constructor(options: ShortLivedCredentialLeaseIssuerOptions = {}) {
    const ttlSeconds = options.ttlSeconds ?? SEND_CREDENTIAL_LEASE_TTL_SECONDS;
    if (
      !Number.isInteger(ttlSeconds)
      || ttlSeconds < 1
      || ttlSeconds > SEND_CREDENTIAL_LEASE_TTL_SECONDS
    ) {
      throw new Error('CREDENTIAL_LEASE_TTL_INVALID');
    }

    this.#ttlSeconds = ttlSeconds;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseId = options.leaseId ?? (() => crypto.randomUUID());
    this.#auditId = options.auditId ?? (() => crypto.randomUUID());
  }

  async issue(input: CredentialLeaseIssuerInput): Promise<CredentialLease> {
    const issuedAt = requireIso(this.#now(), 'CREDENTIAL_LEASE_ISSUED_AT_INVALID');
    const maximumLeaseSeconds = input.maximumLeaseSeconds;
    if (!Number.isInteger(maximumLeaseSeconds) || maximumLeaseSeconds < 1) {
      throw new Error('CREDENTIAL_LEASE_MAXIMUM_INVALID');
    }

    const ttlSeconds = Math.min(this.#ttlSeconds, maximumLeaseSeconds);
    const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
    const leaseId = stableReferencePart(this.#leaseId(), 'CREDENTIAL_LEASE_ID_INVALID');
    const auditId = stableReferencePart(this.#auditId(), 'CREDENTIAL_LEASE_AUDIT_ID_INVALID');

    return {
      leaseReference: `lease://credential/${leaseId}`,
      tenantId: input.request.tenantId,
      connectorKey: input.request.connectorKey,
      credentialReference: input.credentialReference,
      authorizationDecisionId: input.authorizationDecisionId,
      issuedAt,
      expiresAt,
      auditReference: `audit://credential-lease/${auditId}`,
    };
  }
}

function requireIso(value: string, code: string): string {
  if (value.trim() !== value || !Number.isFinite(Date.parse(value))) {
    throw new Error(code);
  }
  return new Date(value).toISOString();
}

function stableReferencePart(value: string, code: string): string {
  if (
    value.length === 0
    || value !== value.trim()
    || /[\r\n\t/]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}
