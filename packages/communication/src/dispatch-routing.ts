import {
  routeConnector,
  type ConnectorDefinition,
  type ConnectorRouteReason,
  type RoutingPolicy,
} from '@platform-hub/provider-registry';
import type { CommunicationDispatchReasonCode } from './index.ts';
import type { PreparedCommunicationDispatch } from './dispatch.ts';

export interface RoutedCommunicationConnector {
  readonly connectorKey: string;
  readonly providerType: string;
  readonly providerKey: string;
  readonly ownership: ConnectorDefinition['ownership'];
  readonly region?: string;
}

export type CommunicationDispatchRouteResult =
  | {
      readonly routed: true;
      readonly connector: RoutedCommunicationConnector;
      readonly considered: readonly string[];
      readonly rejected: Readonly<Record<string, readonly string[]>>;
    }
  | {
      readonly routed: false;
      readonly reasonCode: Extract<
        CommunicationDispatchReasonCode,
        'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'RESIDENCY_BLOCKED' | 'GOVERNANCE_BLOCKED'
      >;
      readonly routeReason: ConnectorRouteReason;
      readonly considered: readonly string[];
      readonly rejected: Readonly<Record<string, readonly string[]>>;
    };

/**
 * Pure bridge from a prepared communication envelope to the EXPADIO Provider
 * Registry. It selects connector metadata only; it never exposes credentialRef
 * and never invokes a provider adapter.
 */
export function routePreparedCommunicationDispatch(
  dispatch: PreparedCommunicationDispatch,
  connectors: readonly ConnectorDefinition[],
  policy?: RoutingPolicy,
): CommunicationDispatchRouteResult {
  const route = routeConnector(
    {
      tenantId: dispatch.tenantId,
      capabilityKey: dispatch.routing.capabilityKey,
      ...(dispatch.routing.requiredRegions === undefined
        ? {}
        : { requiredRegions: dispatch.routing.requiredRegions }),
      ...(dispatch.routing.requiredResidencyTags === undefined
        ? {}
        : { requiredResidencyTags: dispatch.routing.requiredResidencyTags }),
      ...(dispatch.routing.requiredComplianceTags === undefined
        ? {}
        : { requiredComplianceTags: dispatch.routing.requiredComplianceTags }),
    },
    connectors,
    policy,
  );

  if (route.connector === null) {
    return {
      routed: false,
      reasonCode: dispatchRouteFailureCode(dispatch, route.reason, route.considered),
      routeReason: route.reason,
      considered: route.considered,
      rejected: route.rejected,
    };
  }

  return {
    routed: true,
    connector: {
      connectorKey: route.connector.connectorKey,
      providerType: route.connector.providerType,
      providerKey: route.connector.providerKey,
      ownership: route.connector.ownership,
      ...(route.connector.region === undefined ? {} : { region: route.connector.region }),
    },
    considered: route.considered,
    rejected: route.rejected,
  };
}

function dispatchRouteFailureCode(
  dispatch: PreparedCommunicationDispatch,
  routeReason: ConnectorRouteReason,
  considered: readonly string[],
): Extract<
  CommunicationDispatchReasonCode,
  'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'RESIDENCY_BLOCKED' | 'GOVERNANCE_BLOCKED'
> {
  if (considered.length === 0) return 'NOT_CONFIGURED';
  if (routeReason === 'NO_ENABLED_CONNECTOR') return 'PROVIDER_UNAVAILABLE';

  const residencyConstrained =
    (dispatch.routing.requiredRegions?.length ?? 0) > 0 ||
    (dispatch.routing.requiredResidencyTags?.length ?? 0) > 0;

  return residencyConstrained ? 'RESIDENCY_BLOCKED' : 'GOVERNANCE_BLOCKED';
}
