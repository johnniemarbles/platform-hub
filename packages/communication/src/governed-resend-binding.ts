import type {
  ConnectorDefinition,
  CredentialLease,
  CredentialLeaseRequest,
  GovernedCredentialLeaseService,
} from '@platform-hub/provider-registry';
import type {
  ConnectorCredentialRepository,
  SecretResolver,
} from '@platform-hub/provider-registry/repository';
import type { ResendApiTokenProvider, ResendCredentialRequest } from './resend-email-adapter.ts';

const RESEND_PROVIDER_KEY = 'resend';
const EMAIL_CAPABILITY_KEY = 'communication.email.send';

export type CredentialLeaseService = Pick<GovernedCredentialLeaseService, 'issue'>;

export interface GovernedResendCredentialProviderOptions {
  readonly connector: ConnectorDefinition;
  readonly credentialRepository: ConnectorCredentialRepository;
  readonly leaseService: CredentialLeaseService;
  readonly secretResolver: SecretResolver;
  readonly requestedBySubjectId: string;
  readonly requestId: () => string;
  readonly correlationId: () => string;
  readonly now?: () => string;
}

export type GovernedResendCredentialErrorCode =
  | 'RESEND_CONNECTOR_INVALID'
  | 'RESEND_CREDENTIAL_REFERENCE_UNAVAILABLE'
  | 'RESEND_SECRET_EXPIRED';

export class GovernedResendCredentialError extends Error {
  readonly code: GovernedResendCredentialErrorCode;

  constructor(code: GovernedResendCredentialErrorCode, message: string) {
    super(message);
    this.name = 'GovernedResendCredentialError';
    this.code = code;
  }
}

/**
 * Produces a send-time token callback for one routed Resend connector. The
 * credential reference is loaded through the infrastructure repository,
 * authorized/audited through a short-lived lease, and resolved only after that
 * lease succeeds. The raw secret is returned directly to the adapter and is
 * never added to communication or provider-registry domain records.
 */
export function governedResendApiTokenProvider(
  options: GovernedResendCredentialProviderOptions,
): ResendApiTokenProvider {
  validateConnector(options.connector);
  stable(options.requestedBySubjectId, 'requested subject id');

  return async (request: ResendCredentialRequest): Promise<string> => {
    const credentialReference = await options.credentialRepository.loadCredentialReference(
      request.tenantId,
      options.connector.connectorKey,
    );
    if (credentialReference === null) {
      throw new GovernedResendCredentialError(
        'RESEND_CREDENTIAL_REFERENCE_UNAVAILABLE',
        'Resend connector has no managed credential reference.',
      );
    }

    const leaseRequest: CredentialLeaseRequest = {
      requestId: stable(options.requestId(), 'credential request id'),
      tenantId: request.tenantId,
      requestedBySubjectId: options.requestedBySubjectId,
      connectorKey: options.connector.connectorKey,
      purpose: `communication.email.send:${request.purpose}`,
      requestedAt: request.requestedAt,
      correlationId: stable(options.correlationId(), 'credential correlation id'),
      evidenceRefs: [
        `communication://trigger/${encodeURIComponent(request.triggerKey)}`,
        `communication://idempotency/${encodeURIComponent(request.idempotencyKey)}`,
      ],
    };
    const connector = { ...options.connector, credentialRef: credentialReference };
    const lease = await options.leaseService.issue(leaseRequest, connector);
    const resolvedAt = options.now?.() ?? new Date().toISOString();
    assertLeaseIsCurrent(lease, resolvedAt);

    const secret = await options.secretResolver.resolve(lease.credentialReference);
    if (secret.expiresAt !== undefined && secret.expiresAt.getTime() <= Date.parse(resolvedAt)) {
      throw new GovernedResendCredentialError(
        'RESEND_SECRET_EXPIRED',
        'Resolved Resend credential is expired.',
      );
    }
    return secret.value;
  };
}

function validateConnector(connector: ConnectorDefinition): void {
  const valid = connector.enabled
    && connector.providerKey.trim().toLowerCase() === RESEND_PROVIDER_KEY
    && connector.capabilityKeys.includes(EMAIL_CAPABILITY_KEY);
  if (!valid) {
    throw new GovernedResendCredentialError(
      'RESEND_CONNECTOR_INVALID',
      'Connector is not an enabled Resend email connector.',
    );
  }
}

function assertLeaseIsCurrent(lease: CredentialLease, requestedAt: string): void {
  const at = Date.parse(requestedAt);
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > at || expiresAt <= at) {
    throw new GovernedResendCredentialError(
      'RESEND_SECRET_EXPIRED',
      'Resend credential lease is not active for this send attempt.',
    );
  }
}

function stable(value: string, label: string): string {
  if (value.trim().length === 0 || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new GovernedResendCredentialError(
      'RESEND_CONNECTOR_INVALID',
      `${label} is invalid.`,
    );
  }
  return value;
}

export type { SecretResolver } from '@platform-hub/provider-registry/repository';
