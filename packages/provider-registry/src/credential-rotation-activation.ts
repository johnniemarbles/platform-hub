import type {
  CredentialReference,
  CredentialRotationEvent,
  CredentialRotationRepository,
} from './index.ts';

export interface CredentialRotationActivationRequest {
  readonly tenantId: string;
  readonly rotationReference: string;
  readonly requestedBySubjectId: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface CredentialRotationActivationDecision {
  readonly decisionId: string;
  readonly allowed: boolean;
  readonly reasonKey: string;
}

export interface CredentialRotationActivationAuthorizer {
  authorize(input: CredentialRotationActivationRequest & {
    readonly action: 'credential.rotation.activate';
    readonly connectorKey: string;
    readonly currentCredentialReference: CredentialReference;
    readonly replacementCredentialReference: CredentialReference;
  }): Promise<CredentialRotationActivationDecision>;
}

export interface CredentialRotationActivation {
  readonly rotationReference: string;
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly currentCredentialReference: CredentialReference;
  readonly replacementCredentialReference: CredentialReference;
  readonly authorizationDecisionId: string;
  readonly status: 'ACTIVATED';
  readonly activatedAt: string;
  readonly auditReference: string;
}

export interface CredentialRotationActivator {
  activate(input: {
    readonly request: CredentialRotationActivationRequest;
    readonly stagedEvent: CredentialRotationEvent;
    readonly authorizationDecisionId: string;
  }): Promise<CredentialRotationActivation>;
}

export class GovernedCredentialRotationActivationService {
  readonly #repository: CredentialRotationRepository;
  readonly #authorizer: CredentialRotationActivationAuthorizer;
  readonly #activator: CredentialRotationActivator;
  readonly #eventId: () => string;

  constructor(
    repository: CredentialRotationRepository,
    authorizer: CredentialRotationActivationAuthorizer,
    activator: CredentialRotationActivator,
    eventId: () => string,
  ) {
    this.#repository = repository;
    this.#authorizer = authorizer;
    this.#activator = activator;
    this.#eventId = eventId;
  }

  async activate(
    request: CredentialRotationActivationRequest,
  ): Promise<CredentialRotationActivation> {
    validateRequest(request);
    const history = await this.#repository.load(
      request.tenantId,
      request.rotationReference,
    );
    const staged = history.at(-1);
    if (staged === undefined || staged.eventType !== 'STAGED') {
      throw new Error('CREDENTIAL_ROTATION_NOT_STAGED');
    }

    const decision = await this.#authorizer.authorize({
      ...request,
      action: 'credential.rotation.activate',
      connectorKey: staged.connectorKey,
      currentCredentialReference: staged.currentCredentialReference,
      replacementCredentialReference: staged.replacementCredentialReference,
    });
    stable(decision.decisionId);
    stable(decision.reasonKey);
    if (!decision.allowed) {
      throw new Error('CREDENTIAL_ROTATION_ACTIVATION_DENIED:' + decision.reasonKey);
    }

    const activation = await this.#activator.activate({
      request,
      stagedEvent: staged,
      authorizationDecisionId: decision.decisionId,
    });
    validateActivation(activation, request, staged, decision.decisionId);

    const event: CredentialRotationEvent = {
      eventId: this.#eventId(),
      rotationReference: staged.rotationReference,
      sequence: staged.sequence + 1,
      requestId: staged.requestId,
      tenantId: staged.tenantId,
      requestedBySubjectId: request.requestedBySubjectId,
      connectorKey: staged.connectorKey,
      currentCredentialReference: staged.currentCredentialReference,
      replacementCredentialReference: staged.replacementCredentialReference,
      eventType: 'ACTIVATED',
      authorizationDecisionId: decision.decisionId,
      reason: request.reason,
      occurredAt: activation.activatedAt,
      correlationId: request.correlationId,
      evidenceRefs: [...request.evidenceRefs, activation.auditReference],
    };
    const appended = await this.#repository.append(event);
    if (
      appended.event.eventId !== event.eventId
      || appended.event.rotationReference !== event.rotationReference
      || appended.event.sequence !== event.sequence
    ) {
      throw new Error('CREDENTIAL_ROTATION_ACTIVATION_AUDIT_MISMATCH');
    }
    return activation;
  }
}

function validateRequest(request: CredentialRotationActivationRequest): void {
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
    throw new Error('CREDENTIAL_ROTATION_ACTIVATION_REQUEST_INVALID');
  }
}

function validateActivation(
  activation: CredentialRotationActivation,
  request: CredentialRotationActivationRequest,
  staged: CredentialRotationEvent,
  decisionId: string,
): void {
  const matches = activation.rotationReference === staged.rotationReference
    && activation.tenantId === request.tenantId
    && activation.connectorKey === staged.connectorKey
    && activation.currentCredentialReference === staged.currentCredentialReference
    && activation.replacementCredentialReference === staged.replacementCredentialReference
    && activation.authorizationDecisionId === decisionId
    && activation.status === 'ACTIVATED';
  try {
    stable(activation.auditReference);
  } catch {
    throw new Error('CREDENTIAL_ROTATION_ACTIVATION_INVALID');
  }
  if (!matches || !Number.isFinite(Date.parse(activation.activatedAt))) {
    throw new Error('CREDENTIAL_ROTATION_ACTIVATION_INVALID');
  }
}

function stable(value: string): void {
  if (value.trim() === '' || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error('CREDENTIAL_ROTATION_ACTIVATION_INVALID');
  }
}
