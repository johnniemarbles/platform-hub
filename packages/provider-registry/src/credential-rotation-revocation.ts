import type {
  CredentialReference,
  CredentialRotationEvent,
  CredentialRotationRepository,
} from './index.ts';

export interface CredentialRotationRevocationRequest {
  readonly tenantId: string;
  readonly rotationReference: string;
  readonly requestedBySubjectId: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface CredentialRotationRevocationDecision {
  readonly decisionId: string;
  readonly allowed: boolean;
  readonly reasonKey: string;
}

export interface CredentialRotationRevocationAuthorizer {
  authorize(input: CredentialRotationRevocationRequest & {
    readonly action: 'credential.rotation.revoke-superseded';
    readonly connectorKey: string;
    readonly supersededCredentialReference: CredentialReference;
    readonly activeCredentialReference: CredentialReference;
  }): Promise<CredentialRotationRevocationDecision>;
}

export interface CredentialRotationRevocation {
  readonly rotationReference: string;
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly revokedCredentialReference: CredentialReference;
  readonly activeCredentialReference: CredentialReference;
  readonly authorizationDecisionId: string;
  readonly status: 'REVOKED';
  readonly revokedAt: string;
  readonly auditReference: string;
}

export interface CredentialRotationRevoker {
  revoke(input: {
    readonly request: CredentialRotationRevocationRequest;
    readonly activatedEvent: CredentialRotationEvent;
    readonly authorizationDecisionId: string;
  }): Promise<CredentialRotationRevocation>;
}

export class GovernedCredentialRotationRevocationService {
  readonly #repository: CredentialRotationRepository;
  readonly #authorizer: CredentialRotationRevocationAuthorizer;
  readonly #revoker: CredentialRotationRevoker;
  readonly #eventId: () => string;

  constructor(
    repository: CredentialRotationRepository,
    authorizer: CredentialRotationRevocationAuthorizer,
    revoker: CredentialRotationRevoker,
    eventId: () => string,
  ) {
    this.#repository = repository;
    this.#authorizer = authorizer;
    this.#revoker = revoker;
    this.#eventId = eventId;
  }

  async revoke(
    request: CredentialRotationRevocationRequest,
  ): Promise<CredentialRotationRevocation> {
    validateRequest(request);
    const history = await this.#repository.load(
      request.tenantId,
      request.rotationReference,
    );
    const activated = history.at(-1);
    if (activated === undefined || activated.eventType !== 'ACTIVATED') {
      throw new Error('CREDENTIAL_ROTATION_NOT_ACTIVATED');
    }

    const decision = await this.#authorizer.authorize({
      ...request,
      action: 'credential.rotation.revoke-superseded',
      connectorKey: activated.connectorKey,
      supersededCredentialReference: activated.currentCredentialReference,
      activeCredentialReference: activated.replacementCredentialReference,
    });
    stable(decision.decisionId);
    stable(decision.reasonKey);
    if (!decision.allowed) {
      throw new Error('CREDENTIAL_ROTATION_REVOCATION_DENIED:' + decision.reasonKey);
    }

    const revocation = await this.#revoker.revoke({
      request,
      activatedEvent: activated,
      authorizationDecisionId: decision.decisionId,
    });
    validateRevocation(revocation, request, activated, decision.decisionId);

    const event: CredentialRotationEvent = {
      eventId: this.#eventId(),
      rotationReference: activated.rotationReference,
      sequence: activated.sequence + 1,
      requestId: activated.requestId,
      tenantId: activated.tenantId,
      requestedBySubjectId: request.requestedBySubjectId,
      connectorKey: activated.connectorKey,
      currentCredentialReference: activated.currentCredentialReference,
      replacementCredentialReference: activated.replacementCredentialReference,
      eventType: 'REVOKED',
      authorizationDecisionId: decision.decisionId,
      reason: request.reason,
      occurredAt: revocation.revokedAt,
      correlationId: request.correlationId,
      evidenceRefs: [...request.evidenceRefs, revocation.auditReference],
    };
    const appended = await this.#repository.append(event);
    if (
      appended.event.eventId !== event.eventId
      || appended.event.rotationReference !== event.rotationReference
      || appended.event.sequence !== event.sequence
    ) {
      throw new Error('CREDENTIAL_ROTATION_REVOCATION_AUDIT_MISMATCH');
    }
    return revocation;
  }
}

function validateRequest(request: CredentialRotationRevocationRequest): void {
  const values = [
    request.tenantId,
    request.rotationReference,
    request.requestedBySubjectId,
    request.reason,
    request.correlationId,
    ...request.evidenceRefs,
  ];
  if (
    values.some((value) => value.trim() === '' || value !== value.trim())
    || request.evidenceRefs.length === 0
    || !Number.isFinite(Date.parse(request.requestedAt))
  ) {
    throw new Error('CREDENTIAL_ROTATION_REVOCATION_REQUEST_INVALID');
  }
}

function validateRevocation(
  revocation: CredentialRotationRevocation,
  request: CredentialRotationRevocationRequest,
  activated: CredentialRotationEvent,
  decisionId: string,
): void {
  const matches = revocation.rotationReference === activated.rotationReference
    && revocation.tenantId === request.tenantId
    && revocation.connectorKey === activated.connectorKey
    && revocation.revokedCredentialReference === activated.currentCredentialReference
    && revocation.activeCredentialReference === activated.replacementCredentialReference
    && revocation.authorizationDecisionId === decisionId
    && revocation.status === 'REVOKED';
  try {
    stable(revocation.auditReference);
  } catch {
    throw new Error('CREDENTIAL_ROTATION_REVOCATION_INVALID');
  }
  if (!matches || !Number.isFinite(Date.parse(revocation.revokedAt))) {
    throw new Error('CREDENTIAL_ROTATION_REVOCATION_INVALID');
  }
}

function stable(value: string): void {
  if (value.trim() === '' || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error('CREDENTIAL_ROTATION_REVOCATION_INVALID');
  }
}
