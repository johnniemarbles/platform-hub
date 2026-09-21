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
import type {
  AiApiTokenProvider,
  AiCredentialRequest,
} from './gemini-adapter.ts';

export type AiCredentialLeaseService =
  Pick<GovernedCredentialLeaseService, 'issue'>;

export interface GovernedAiCredentialProviderOptions {
  readonly connectors: readonly ConnectorDefinition[];
  readonly credentialRepository: ConnectorCredentialRepository;
  readonly leaseService: AiCredentialLeaseService;
  readonly secretResolver: SecretResolver;
  readonly requestedBySubjectId: string;
  readonly requestId: () => string;
  readonly correlationId: () => string;
  readonly now?: () => string;
}

export type GovernedAiCredentialErrorCode =
  | 'AI_CONNECTOR_INVALID'
  | 'AI_CREDENTIAL_REFERENCE_UNAVAILABLE'
  | 'AI_SECRET_EXPIRED';

export class GovernedAiCredentialError extends Error {
  readonly code: GovernedAiCredentialErrorCode;

  constructor(code: GovernedAiCredentialErrorCode, message: string) {
    super(message);
    this.name = 'GovernedAiCredentialError';
    this.code = code;
  }
}

export function governedAiApiTokenProvider(
  options: GovernedAiCredentialProviderOptions,
): AiApiTokenProvider {
  stable(options.requestedBySubjectId, 'requested subject id');
  const byKey = new Map(
    options.connectors.map((connector) => [connector.connectorKey, connector]),
  );

  return async (request: AiCredentialRequest): Promise<string> => {
    const connector = byKey.get(request.connectorKey);
    if (connector === undefined) {
      throw new GovernedAiCredentialError(
        'AI_CONNECTOR_INVALID',
        'Routed AI connector is not available to this credential provider.',
      );
    }
    validateConnector(connector, request);

    const credentialReference =
      await options.credentialRepository.loadCredentialReference(
        request.tenantId,
        connector.connectorKey,
      );
    if (credentialReference === null) {
      throw new GovernedAiCredentialError(
        'AI_CREDENTIAL_REFERENCE_UNAVAILABLE',
        'AI connector has no managed credential reference.',
      );
    }

    const leaseRequest: CredentialLeaseRequest = {
      requestId: stable(options.requestId(), 'credential request id'),
      tenantId: request.tenantId,
      requestedBySubjectId: options.requestedBySubjectId,
      connectorKey: connector.connectorKey,
      purpose: `ai.${request.operation.toLowerCase()}:${request.purpose}`,
      requestedAt: request.requestedAt,
      correlationId: stable(
        options.correlationId(),
        'credential correlation id',
      ),
      evidenceRefs: [
        `ai://invocation/${encodeURIComponent(request.idempotencyKey)}`,
        `ai://capability/ai.${request.operation.toLowerCase()}`,
      ],
    };

    const lease = await options.leaseService.issue(
      { ...leaseRequest },
      { ...connector, credentialRef: credentialReference },
    );
    const resolvedAt = options.now?.() ?? new Date().toISOString();
    assertLeaseCurrent(lease, resolvedAt);

    const secret = await options.secretResolver.resolve(
      lease.credentialReference,
    );
    if (
      secret.expiresAt !== undefined
      && secret.expiresAt.getTime() <= Date.parse(resolvedAt)
    ) {
      throw new GovernedAiCredentialError(
        'AI_SECRET_EXPIRED',
        'Resolved AI credential is expired.',
      );
    }
    return secret.value;
  };
}

function validateConnector(
  connector: ConnectorDefinition,
  request: AiCredentialRequest,
): void {
  const capability = `ai.${request.operation.toLowerCase()}`;
  const valid =
    connector.enabled
    && connector.health !== 'UNHEALTHY'
    && connector.connectorKey === request.connectorKey
    && connector.capabilityKeys.includes(capability)
    && connector.ownership === 'TENANT'
    && connector.tenantId === request.tenantId;
  if (!valid) {
    throw new GovernedAiCredentialError(
      'AI_CONNECTOR_INVALID',
      'Connector is not enabled and scoped to this AI request.',
    );
  }
}

function assertLeaseCurrent(
  lease: CredentialLease,
  requestedAt: string,
): void {
  const at = Date.parse(requestedAt);
  const issued = Date.parse(lease.issuedAt);
  const expires = Date.parse(lease.expiresAt);
  if (
    !Number.isFinite(at)
    || !Number.isFinite(issued)
    || !Number.isFinite(expires)
    || issued > at
    || expires <= at
  ) {
    throw new GovernedAiCredentialError(
      'AI_SECRET_EXPIRED',
      'AI credential lease is not active for this invocation.',
    );
  }
}

function stable(value: string, label: string): string {
  if (
    value.trim().length === 0
    || value !== value.trim()
    || /[\r\n\t]/u.test(value)
  ) {
    throw new GovernedAiCredentialError(
      'AI_CONNECTOR_INVALID',
      `${label} is invalid.`,
    );
  }
  return value;
}

export type { SecretResolver } from '@platform-hub/provider-registry/repository';
