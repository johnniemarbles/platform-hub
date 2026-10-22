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
import type { VoiceApiTokenProvider, VoiceCredentialRequest } from './deepgram-stt-adapter.ts';
import { voiceCapabilityKey } from './routing.ts';

export type VoiceCredentialLeaseService = Pick<GovernedCredentialLeaseService, 'issue'>;

export interface GovernedVoiceCredentialProviderOptions {
  readonly connectors: readonly ConnectorDefinition[];
  readonly credentialRepository: ConnectorCredentialRepository;
  readonly leaseService: VoiceCredentialLeaseService;
  readonly secretResolver: SecretResolver;
  readonly requestedBySubjectId: string;
  readonly requestId: () => string;
  readonly correlationId: () => string;
  readonly now?: () => string;
}

export class GovernedVoiceCredentialError extends Error {
  readonly code = 'VOICE_CREDENTIAL_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'GovernedVoiceCredentialError';
  }
}

export function governedVoiceApiTokenProvider(
  options: GovernedVoiceCredentialProviderOptions,
): VoiceApiTokenProvider {
  const byKey = new Map(options.connectors.map((connector) => [connector.connectorKey, connector]));
  return async (request: VoiceCredentialRequest): Promise<string> => {
    const connector = byKey.get(request.connectorKey);
    if (connector === undefined || !connector.enabled) {
      throw new GovernedVoiceCredentialError('Routed voice connector is not available.');
    }
    const capability = voiceCapabilityKey(request.operation);
    if (!connector.capabilityKeys.includes(capability) && request.operation !== 'STREAM_CONVERSATION') {
      throw new GovernedVoiceCredentialError('Connector is not scoped to this voice operation.');
    }
    const credentialReference = await options.credentialRepository.loadCredentialReference(
      request.tenantId,
      connector.connectorKey,
    );
    if (credentialReference === null) {
      throw new GovernedVoiceCredentialError('Voice connector has no managed credential reference.');
    }
    const leaseRequest: CredentialLeaseRequest = {
      requestId: options.requestId(),
      tenantId: request.tenantId,
      requestedBySubjectId: options.requestedBySubjectId,
      connectorKey: connector.connectorKey,
      purpose: `voice.${request.operation.toLowerCase()}:${request.purpose}`,
      requestedAt: request.requestedAt,
      correlationId: options.correlationId(),
      evidenceRefs: [
        `voice://invocation/${encodeURIComponent(request.idempotencyKey)}`,
        `voice://capability/${capability}`,
      ],
    };
    const lease: CredentialLease = await options.leaseService.issue(
      leaseRequest,
      { ...connector, credentialRef: credentialReference },
    );
    const resolvedAt = options.now?.() ?? new Date().toISOString();
    if (Date.parse(lease.expiresAt) <= Date.parse(resolvedAt)) {
      throw new GovernedVoiceCredentialError('Voice credential lease is not active.');
    }
    const secret = await options.secretResolver.resolve(lease.credentialReference);
    if (secret.expiresAt !== undefined && secret.expiresAt.getTime() <= Date.parse(resolvedAt)) {
      throw new GovernedVoiceCredentialError('Resolved voice credential is expired.');
    }
    return secret.value;
  };
}
