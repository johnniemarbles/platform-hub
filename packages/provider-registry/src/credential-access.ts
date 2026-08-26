import type { ConnectorDefinition, CredentialReference } from './index.ts';

const ABSOLUTE_MAXIMUM_LEASE_SECONDS = 900;

export interface CredentialLeaseRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly requestedBySubjectId: string;
  readonly connectorKey: string;
  readonly purpose: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface CredentialLeaseAuthorizationQuery extends CredentialLeaseRequest {
  readonly action: 'credential.lease';
  readonly credentialReference: CredentialReference;
}

export interface CredentialLeaseAuthorizationDecision {
  readonly decisionId: string;
  readonly allowed: boolean;
  readonly reasonKey: string;
}

export interface CredentialLeaseAuthorizer {
  authorize(query: CredentialLeaseAuthorizationQuery): Promise<CredentialLeaseAuthorizationDecision>;
}

export interface CredentialLeaseIssuerInput {
  readonly request: CredentialLeaseRequest;
  readonly credentialReference: CredentialReference;
  readonly authorizationDecisionId: string;
  readonly maximumLeaseSeconds: number;
}

export interface CredentialLease {
  readonly leaseReference: string;
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly credentialReference: CredentialReference;
  readonly authorizationDecisionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly auditReference: string;
}

export interface CredentialLeaseIssuer {
  issue(input: CredentialLeaseIssuerInput): Promise<CredentialLease>;
}

export type CredentialLeaseErrorCode =
  | 'CREDENTIAL_LEASE_REQUEST_INVALID'
  | 'CREDENTIAL_CONNECTOR_MISMATCH'
  | 'CREDENTIAL_REFERENCE_REQUIRED'
  | 'CREDENTIAL_LEASE_ACCESS_DENIED'
  | 'CREDENTIAL_LEASE_DECISION_INVALID'
  | 'CREDENTIAL_LEASE_INVALID';

export class CredentialLeaseError extends Error {
  readonly code: CredentialLeaseErrorCode;

  constructor(code: CredentialLeaseErrorCode, message: string) {
    super(message);
    this.name = 'CredentialLeaseError';
    this.code = code;
  }
}

export class GovernedCredentialLeaseService {
  private readonly authorizer: CredentialLeaseAuthorizer;
  private readonly issuer: CredentialLeaseIssuer;
  private readonly maximumLeaseSeconds: number;

  constructor(
    authorizer: CredentialLeaseAuthorizer,
    issuer: CredentialLeaseIssuer,
    maximumLeaseSeconds: number,
  ) {
    if (!Number.isInteger(maximumLeaseSeconds) || maximumLeaseSeconds < 1 ||
      maximumLeaseSeconds > ABSOLUTE_MAXIMUM_LEASE_SECONDS) {
      throw new CredentialLeaseError(
        'CREDENTIAL_LEASE_REQUEST_INVALID',
        'maximum lease duration must be an integer between 1 and 900 seconds',
      );
    }
    this.authorizer = authorizer;
    this.issuer = issuer;
    this.maximumLeaseSeconds = maximumLeaseSeconds;
  }

  async issue(
    request: CredentialLeaseRequest,
    connector: ConnectorDefinition,
  ): Promise<CredentialLease> {
    validateRequest(request);
    if (!connector.enabled || connector.connectorKey !== request.connectorKey ||
      (connector.ownership === 'TENANT' && connector.tenantId !== request.tenantId)) {
      throw new CredentialLeaseError(
        'CREDENTIAL_CONNECTOR_MISMATCH',
        'connector is not enabled and scoped to this request',
      );
    }

    const credentialReference = connector.credentialRef;
    if (credentialReference === undefined) {
      throw new CredentialLeaseError(
        'CREDENTIAL_REFERENCE_REQUIRED',
        'connector has no managed credential reference',
      );
    }

    const decision = await this.authorizer.authorize({
      ...request,
      action: 'credential.lease',
      credentialReference,
    });
    requireStable(decision.decisionId, 'authorization decision id');
    requireStable(decision.reasonKey, 'authorization reason key');
    if (!decision.allowed) {
      throw new CredentialLeaseError(
        'CREDENTIAL_LEASE_ACCESS_DENIED',
        `credential lease denied: ${decision.reasonKey}`,
      );
    }

    const lease = await this.issuer.issue({
      request,
      credentialReference,
      authorizationDecisionId: decision.decisionId,
      maximumLeaseSeconds: this.maximumLeaseSeconds,
    });
    validateLease(lease, request, credentialReference, decision.decisionId, this.maximumLeaseSeconds);
    return lease;
  }
}

function validateRequest(request: CredentialLeaseRequest): void {
  try {
    requireStable(request.requestId, 'request id');
    requireStable(request.tenantId, 'tenant id');
    requireStable(request.requestedBySubjectId, 'subject id');
    requireStable(request.connectorKey, 'connector key');
    requireStable(request.purpose, 'purpose');
    requireStable(request.correlationId, 'correlation id');
    const requestedAt = Date.parse(request.requestedAt);
    if (!Number.isFinite(requestedAt)) throw new Error('invalid requestedAt');
    for (const reference of request.evidenceRefs) requireStable(reference, 'evidence reference');
  } catch (error) {
    throw new CredentialLeaseError(
      'CREDENTIAL_LEASE_REQUEST_INVALID',
      error instanceof Error ? error.message : 'invalid credential lease request',
    );
  }
}

function validateLease(
  lease: CredentialLease,
  request: CredentialLeaseRequest,
  credentialReference: CredentialReference,
  decisionId: string,
  maximumLeaseSeconds: number,
): void {
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  const durationSeconds = (expiresAt - issuedAt) / 1000;
  const matches = lease.tenantId === request.tenantId &&
    lease.connectorKey === request.connectorKey &&
    lease.credentialReference === credentialReference &&
    lease.authorizationDecisionId === decisionId;

  try {
    requireStable(lease.leaseReference, 'lease reference');
    requireStable(lease.auditReference, 'audit reference');
  } catch {
    throw new CredentialLeaseError('CREDENTIAL_LEASE_INVALID', 'lease references are invalid');
  }
  if (!matches || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
    durationSeconds > maximumLeaseSeconds) {
    throw new CredentialLeaseError(
      'CREDENTIAL_LEASE_INVALID',
      'issuer returned an invalid or overlong credential lease',
    );
  }
}

function requireStable(value: string, label: string): void {
  if (value.trim().length === 0 || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new CredentialLeaseError('CREDENTIAL_LEASE_DECISION_INVALID', `${label} is invalid`);
  }
}
