import type { ConnectorDefinition, CredentialReference } from './index.ts';

export interface CredentialRotationRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly requestedBySubjectId: string;
  readonly connectorKey: string;
  readonly replacementCredentialReference: CredentialReference;
  readonly reason: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface CredentialRotationDecision {
  readonly decisionId: string;
  readonly allowed: boolean;
  readonly reasonKey: string;
}

export interface CredentialRotationAuthorizer {
  authorize(input: CredentialRotationRequest & {
    readonly action: 'credential.rotate';
    readonly currentCredentialReference: CredentialReference;
  }): Promise<CredentialRotationDecision>;
}

export interface CredentialRotationStage {
  readonly rotationReference: string;
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly currentCredentialReference: CredentialReference;
  readonly replacementCredentialReference: CredentialReference;
  readonly authorizationDecisionId: string;
  readonly status: 'STAGED';
  readonly stagedAt: string;
  readonly auditReference: string;
}

export interface CredentialRotationStager {
  stage(input: {
    readonly request: CredentialRotationRequest;
    readonly currentCredentialReference: CredentialReference;
    readonly authorizationDecisionId: string;
  }): Promise<CredentialRotationStage>;
}

export type CredentialRotationErrorCode =
  | 'CREDENTIAL_ROTATION_REQUEST_INVALID'
  | 'CREDENTIAL_ROTATION_CONNECTOR_MISMATCH'
  | 'CREDENTIAL_ROTATION_REFERENCE_UNCHANGED'
  | 'CREDENTIAL_ROTATION_ACCESS_DENIED'
  | 'CREDENTIAL_ROTATION_RESULT_INVALID';

export class CredentialRotationError extends Error {
  readonly code: CredentialRotationErrorCode;

  constructor(code: CredentialRotationErrorCode, message: string) {
    super(message);
    this.name = 'CredentialRotationError';
    this.code = code;
  }
}

export class GovernedCredentialRotationService {
  readonly #authorizer: CredentialRotationAuthorizer;
  readonly #stager: CredentialRotationStager;

  constructor(
    authorizer: CredentialRotationAuthorizer,
    stager: CredentialRotationStager,
  ) {
    this.#authorizer = authorizer;
    this.#stager = stager;
  }

  async stage(
    request: CredentialRotationRequest,
    connector: ConnectorDefinition,
  ): Promise<CredentialRotationStage> {
    validateRequest(request);
    if (
      !connector.enabled
      || connector.ownership !== 'TENANT'
      || connector.tenantId !== request.tenantId
      || connector.connectorKey !== request.connectorKey
      || connector.credentialRef === undefined
    ) {
      throw new CredentialRotationError(
        'CREDENTIAL_ROTATION_CONNECTOR_MISMATCH',
        'rotation requires the exact enabled tenant-owned connector',
      );
    }
    if (connector.credentialRef === request.replacementCredentialReference) {
      throw new CredentialRotationError(
        'CREDENTIAL_ROTATION_REFERENCE_UNCHANGED',
        'replacement credential reference must differ from the current reference',
      );
    }

    const decision = await this.#authorizer.authorize({
      ...request,
      action: 'credential.rotate',
      currentCredentialReference: connector.credentialRef,
    });
    stable(decision.decisionId);
    stable(decision.reasonKey);
    if (!decision.allowed) {
      throw new CredentialRotationError(
        'CREDENTIAL_ROTATION_ACCESS_DENIED',
        `credential rotation denied: ${decision.reasonKey}`,
      );
    }

    const result = await this.#stager.stage({
      request,
      currentCredentialReference: connector.credentialRef,
      authorizationDecisionId: decision.decisionId,
    });
    validateResult(result, request, connector.credentialRef, decision.decisionId);
    return result;
  }
}

function validateRequest(request: CredentialRotationRequest): void {
  try {
    [
      request.requestId,
      request.tenantId,
      request.requestedBySubjectId,
      request.connectorKey,
      request.replacementCredentialReference,
      request.reason,
      request.correlationId,
      ...request.evidenceRefs,
    ].forEach(stable);
    if (request.evidenceRefs.length === 0 || !Number.isFinite(Date.parse(request.requestedAt))) {
      throw new Error('invalid evidence or request time');
    }
  } catch {
    throw new CredentialRotationError(
      'CREDENTIAL_ROTATION_REQUEST_INVALID',
      'credential rotation request is invalid',
    );
  }
}

function validateResult(
  result: CredentialRotationStage,
  request: CredentialRotationRequest,
  current: CredentialReference,
  decisionId: string,
): void {
  const matches = result.tenantId === request.tenantId
    && result.connectorKey === request.connectorKey
    && result.currentCredentialReference === current
    && result.replacementCredentialReference === request.replacementCredentialReference
    && result.authorizationDecisionId === decisionId
    && result.status === 'STAGED';
  try {
    stable(result.rotationReference);
    stable(result.auditReference);
  } catch {
    throw new CredentialRotationError(
      'CREDENTIAL_ROTATION_RESULT_INVALID',
      'credential rotation references are invalid',
    );
  }
  if (!matches || !Number.isFinite(Date.parse(result.stagedAt))) {
    throw new CredentialRotationError(
      'CREDENTIAL_ROTATION_RESULT_INVALID',
      'credential rotation result does not match its authorized request',
    );
  }
}

function stable(value: string): void {
  if (value.trim() === '' || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error('unstable value');
  }
}

export type CredentialRotationEventType = 'STAGED' | 'ACTIVATED' | 'REVOKED';

export interface CredentialRotationEvent {
  readonly eventId: string;
  readonly rotationReference: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly tenantId: string;
  readonly requestedBySubjectId: string;
  readonly connectorKey: string;
  readonly currentCredentialReference: CredentialReference;
  readonly replacementCredentialReference: CredentialReference;
  readonly eventType: CredentialRotationEventType;
  readonly authorizationDecisionId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface AppendCredentialRotationEventResult {
  readonly appended: boolean;
  readonly event: CredentialRotationEvent;
}

export interface CredentialRotationRepository {
  append(event: CredentialRotationEvent): Promise<AppendCredentialRotationEventResult>;
  load(
    tenantId: string,
    rotationReference: string,
  ): Promise<readonly CredentialRotationEvent[]>;
}

export function validateCredentialRotationEvent(
  event: CredentialRotationEvent,
): void {
  const values = [
    event.eventId,
    event.rotationReference,
    event.requestId,
    event.tenantId,
    event.requestedBySubjectId,
    event.connectorKey,
    event.currentCredentialReference,
    event.replacementCredentialReference,
    event.authorizationDecisionId,
    event.reason,
    event.correlationId,
    ...event.evidenceRefs,
  ];
  if (
    values.some((value) => value.trim() === '' || value !== value.trim())
    || event.evidenceRefs.length === 0
    || !Number.isInteger(event.sequence)
    || event.sequence < 1
    || !Number.isFinite(Date.parse(event.occurredAt))
    || event.currentCredentialReference === event.replacementCredentialReference
    || ((event.sequence === 1) !== (event.eventType === 'STAGED'))
  ) {
    throw new Error('CREDENTIAL_ROTATION_EVENT_INVALID');
  }
}

export function validateCredentialRotationHistory(
  events: readonly CredentialRotationEvent[],
): readonly CredentialRotationEvent[] {
  let expected = 1;
  let prior: CredentialRotationEvent | undefined;
  for (const event of events) {
    validateCredentialRotationEvent(event);
    if (event.sequence !== expected) {
      throw new Error(
        'CREDENTIAL_ROTATION_EVENT_SEQUENCE_CONFLICT:expected=' + expected,
      );
    }
    if (prior !== undefined) {
      const sameRotation = event.rotationReference === prior.rotationReference
        && event.requestId === prior.requestId
        && event.tenantId === prior.tenantId
        && event.connectorKey === prior.connectorKey
        && event.currentCredentialReference === prior.currentCredentialReference
        && event.replacementCredentialReference === prior.replacementCredentialReference;
      const validTransition =
        (prior.eventType === 'STAGED' && event.eventType === 'ACTIVATED')
        || (prior.eventType === 'ACTIVATED' && event.eventType === 'REVOKED');
      if (!sameRotation || !validTransition) {
        throw new Error('CREDENTIAL_ROTATION_HISTORY_INVALID');
      }
    }
    prior = event;
    expected += 1;
  }
  return events;
}
