export type ConnectorOwnership = 'PLATFORM' | 'TENANT';
export type ConnectorHealth = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'UNHEALTHY';

export type CredentialReference = string & { readonly __credentialReference: unique symbol };

const CREDENTIAL_REF_PREFIXES = ['secret://', 'vault://', 'kms://', 'provider-secret://'] as const;

export function credentialReference(value: string): CredentialReference {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value || /[\r\n\t]/u.test(trimmed)) {
    throw new Error('credential reference must be a non-empty single-line value');
  }
  if (!CREDENTIAL_REF_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    throw new Error(`credential reference must use one of: ${CREDENTIAL_REF_PREFIXES.join(', ')}`);
  }
  return trimmed as CredentialReference;
}

/**
 * Provider credential inheritance across the entity graph.
 *
 * EXPADIO's org hierarchy (Brand HQ / Country OpCo / State Master / Unit) is
 * modeled as platform.entity_nodes *within a single tenant* — a tenant is a
 * brand's whole account, not one node in its org tree. Because routeConnector()
 * below scopes connectors by tenantId only (never by node), a connector
 * configured once with ownership: 'TENANT' is already visible to every entity
 * node in that tenant's hierarchy, with no additional inheritance mechanism
 * needed: a child node never re-enters credentials because there is no
 * per-node filter for it to fail. See provider-registry.test.ts's
 * "tenant-owned connector is visible to every entity node in that tenant"
 * for the pinning test, and packages/entity/src/governance-policy.ts for the
 * unrelated per-node CONFIGURATION concern (publishing policy) that *does*
 * vary by node and is resolved via a separate, explicit inheritance walk.
 *
 * Do not add a parallel node-scoped credential-resolution function or a raw
 * SQL path that reads a connector's credential reference directly — every
 * credential access must go through routeConnector() → a governed credential
 * lease (see credential-access.ts / short-lived-credential-lease-issuer.ts),
 * which is the only place secret expiry and lease auditing are enforced.
 */
export interface ConnectorDefinition {
  readonly connectorKey: string;
  readonly providerType: string;
  readonly providerKey: string;
  readonly ownership: ConnectorOwnership;
  readonly tenantId?: string;
  readonly capabilityKeys: readonly string[];
  readonly credentialRef?: CredentialReference;
  readonly region?: string;
  readonly residencyTags: readonly string[];
  readonly complianceTags: readonly string[];
  readonly health: ConnectorHealth;
  readonly priority: number;
  readonly enabled: boolean;
  readonly fallbackEnabled: boolean;
}

export interface RoutingPolicy {
  readonly tenantId: string;
  readonly capabilityKey: string;
  readonly allowedConnectorKeys?: readonly string[];
  readonly deniedConnectorKeys?: readonly string[];
  readonly requiredRegions?: readonly string[];
  readonly requiredResidencyTags?: readonly string[];
  readonly requiredComplianceTags?: readonly string[];
  readonly preferTenantOwned?: boolean;
}

export interface ConnectorRouteRequest {
  readonly tenantId: string;
  readonly capabilityKey: string;
  readonly requiredRegions?: readonly string[];
  readonly requiredResidencyTags?: readonly string[];
  readonly requiredComplianceTags?: readonly string[];
}

export type ConnectorRouteReason =
  | 'ROUTED'
  | 'NO_ENABLED_CONNECTOR'
  | 'NO_COMPLIANT_CONNECTOR';

export interface ConnectorRouteResult {
  readonly connector: ConnectorDefinition | null;
  readonly reason: ConnectorRouteReason;
  readonly considered: readonly string[];
  readonly rejected: Readonly<Record<string, readonly string[]>>;
}

export function routeConnector(
  request: ConnectorRouteRequest,
  connectors: readonly ConnectorDefinition[],
  policy?: RoutingPolicy,
): ConnectorRouteResult {
  if (policy !== undefined) {
    if (policy.tenantId !== request.tenantId || policy.capabilityKey !== request.capabilityKey) {
      throw new Error('routing policy does not match the request tenant/capability');
    }
  }

  const considered = connectors
    .filter((connector) => connector.capabilityKeys.includes(request.capabilityKey))
    .filter((connector) => connector.ownership === 'PLATFORM' || connector.tenantId === request.tenantId);

  if (considered.length > 0 && considered.every((connector) => !connector.enabled)) {
    return {
      connector: null,
      reason: 'NO_ENABLED_CONNECTOR',
      considered: considered.map((connector) => connector.connectorKey),
      rejected: Object.fromEntries(
        considered.map((connector) => [connector.connectorKey, ['DISABLED'] as const]),
      ),
    };
  }

  const rejected = new Map<string, string[]>();
  const accept = considered.filter((connector) => {
    const reasons = rejectionReasons(request, connector, policy);
    if (reasons.length > 0) rejected.set(connector.connectorKey, reasons);
    return reasons.length === 0;
  });

  accept.sort((a, b) => compareConnectors(a, b, policy?.preferTenantOwned === true));
  const connector = accept[0] ?? null;

  return {
    connector,
    reason: connector === null ? 'NO_COMPLIANT_CONNECTOR' : 'ROUTED',
    considered: considered.map((entry) => entry.connectorKey),
    rejected: Object.fromEntries(rejected.entries()),
  };
}

function rejectionReasons(
  request: ConnectorRouteRequest,
  connector: ConnectorDefinition,
  policy?: RoutingPolicy,
): string[] {
  const reasons: string[] = [];

  if (!connector.enabled) reasons.push('DISABLED');
  if (connector.health === 'UNHEALTHY') reasons.push('UNHEALTHY');

  if (policy?.allowedConnectorKeys !== undefined && !policy.allowedConnectorKeys.includes(connector.connectorKey)) {
    reasons.push('NOT_ALLOWED_BY_POLICY');
  }
  if (policy?.deniedConnectorKeys?.includes(connector.connectorKey) === true) {
    reasons.push('DENIED_BY_POLICY');
  }

  const requestRegions = request.requiredRegions ?? [];
  const policyRegions = policy?.requiredRegions ?? [];
  if (requestRegions.length > 0 && policyRegions.length > 0) {
    const overlap = requestRegions.filter((entry) => policyRegions.includes(entry));
    if (overlap.length === 0) {
      reasons.push('REGION_POLICY_CONFLICT');
    } else if (connector.region === undefined || !overlap.includes(connector.region)) {
      reasons.push('REGION_MISMATCH');
    }
  } else {
    const requiredRegions = requestRegions.length > 0 ? requestRegions : policyRegions;
    if (requiredRegions.length > 0 && (connector.region === undefined || !requiredRegions.includes(connector.region))) {
      reasons.push('REGION_MISMATCH');
    }
  }

  const residency = unionRequirements(request.requiredResidencyTags, policy?.requiredResidencyTags);
  if (!containsAll(connector.residencyTags, residency)) reasons.push('RESIDENCY_MISMATCH');

  const compliance = unionRequirements(request.requiredComplianceTags, policy?.requiredComplianceTags);
  if (!containsAll(connector.complianceTags, compliance)) reasons.push('COMPLIANCE_MISMATCH');

  return reasons;
}

function compareConnectors(a: ConnectorDefinition, b: ConnectorDefinition, preferTenantOwned: boolean): number {
  if (preferTenantOwned && a.ownership !== b.ownership) {
    return a.ownership === 'TENANT' ? -1 : 1;
  }
  const healthRank = (health: ConnectorHealth): number => {
    if (health === 'HEALTHY') return 0;
    if (health === 'DEGRADED') return 1;
    if (health === 'UNKNOWN') return 2;
    return 3;
  };
  const health = healthRank(a.health) - healthRank(b.health);
  if (health !== 0) return health;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.connectorKey.localeCompare(b.connectorKey);
}

function containsAll(actual: readonly string[], required: readonly string[]): boolean {
  return required.every((entry) => actual.includes(entry));
}

function unionRequirements(a?: readonly string[], b?: readonly string[]): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

export * from './credential-access.ts';
export * from './short-lived-credential-lease-issuer.ts';
export * from './audited-credential-issuer.ts';
export * from './credential-rotation.ts';
export * from './credential-rotation-activation.ts';
export * from './credential-rotation-revocation.ts';

export * from './persisted-credential-lease-authorizer.ts';
