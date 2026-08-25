import type {
  ConnectorDefinition,
  ConnectorRouteRequest,
  ConnectorRouteResult,
  CredentialReference,
  RoutingPolicy,
} from './index.ts';
import { routeConnector } from './index.ts';

export interface ProviderRegistryRepository {
  listConnectors(tenantId: string, capabilityKey: string): Promise<readonly ConnectorDefinition[]>;
  loadRoutingPolicy(tenantId: string, capabilityKey: string): Promise<RoutingPolicy | null>;
}

/**
 * Credential references are intentionally separated from normal connector
 * discovery. Implementations should require an infrastructure/provider-adapter
 * role rather than the ordinary tenant application role.
 */
export interface ConnectorCredentialRepository {
  loadCredentialReference(
    tenantId: string,
    connectorKey: string,
  ): Promise<CredentialReference | null>;
}

export interface ResolvedSecret {
  readonly value: string;
  readonly version?: string;
  readonly expiresAt?: Date;
}

/**
 * Infrastructure adapter boundary for Vault/KMS/provider secret storage.
 * Domain persistence never stores `ResolvedSecret.value`.
 */
export interface SecretResolver {
  resolve(reference: CredentialReference): Promise<ResolvedSecret>;
}

export async function routeConnectorFromRegistry(
  repository: ProviderRegistryRepository,
  request: ConnectorRouteRequest,
): Promise<ConnectorRouteResult> {
  const [connectors, policy] = await Promise.all([
    repository.listConnectors(request.tenantId, request.capabilityKey),
    repository.loadRoutingPolicy(request.tenantId, request.capabilityKey),
  ]);
  return routeConnector(request, connectors, policy ?? undefined);
}
