import type {
  CredentialLease,
  CredentialLeaseAuditRepository,
  CredentialLeaseIssuer,
  CredentialLeaseIssuerInput,
} from './credential-access.ts';

export class AuditedCredentialLeaseIssuer implements CredentialLeaseIssuer {
  readonly #issuer: CredentialLeaseIssuer;
  readonly #auditRepository: CredentialLeaseAuditRepository;
  readonly #eventId: () => string;
  readonly #recordedAt: () => string;

  constructor(
    issuer: CredentialLeaseIssuer,
    auditRepository: CredentialLeaseAuditRepository,
    eventId: () => string,
    recordedAt: () => string,
  ) {
    this.#issuer = issuer;
    this.#auditRepository = auditRepository;
    this.#eventId = eventId;
    this.#recordedAt = recordedAt;
  }

  async issue(input: CredentialLeaseIssuerInput): Promise<CredentialLease> {
    const lease = await this.#issuer.issue(input);
    const event = {
      eventId: this.#eventId(),
      request: input.request,
      credentialReference: input.credentialReference,
      authorizationDecisionId: input.authorizationDecisionId,
      authorizationReasonKey: input.authorizationReasonKey,
      outcome: 'ISSUED',
      leaseReference: lease.leaseReference,
      issuerAuditReference: lease.auditReference,
      failureReasonKey: null,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      recordedAt: this.#recordedAt(),
    } as const;

    const recorded = await this.#auditRepository.record(event);
    if (
      recorded.event.eventId !== event.eventId
      || recorded.event.request.tenantId !== input.request.tenantId
      || recorded.event.request.requestId !== input.request.requestId
    ) {
      throw new Error('CREDENTIAL_LEASE_AUDIT_MISMATCH');
    }
    return lease;
  }
}
