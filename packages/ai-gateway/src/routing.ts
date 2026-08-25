import {
  routeConnector,
  type ConnectorDefinition,
  type RoutingPolicy,
} from '@platform-hub/provider-registry';
import {
  validateAiInvocationIntent,
  validateAiProposal,
  type AiGateway,
  type AiInvocationIntent,
  type AiOperation,
  type AiProposal,
} from './index.ts';

export interface AiProviderAdapter {
  invoke(input: {
    readonly intent: AiInvocationIntent;
    /** Contains at most a managed credential reference, never raw secret data. */
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal>;
}

export type RoutedAiGatewayErrorCode =
  | 'AI_INTENT_INVALID'
  | 'AI_CONNECTOR_UNAVAILABLE'
  | 'AI_ADAPTER_NOT_REGISTERED'
  | 'AI_PROPOSAL_INVALID'
  | 'AI_COST_LIMIT_EXCEEDED';

export class RoutedAiGatewayError extends Error {
  readonly code: RoutedAiGatewayErrorCode;

  constructor(code: RoutedAiGatewayErrorCode, message: string) {
    super(message);
    this.name = 'RoutedAiGatewayError';
    this.code = code;
  }
}

/**
 * Provider-neutral gateway. Routing applies tenant, residency, compliance,
 * health, ownership, and policy constraints before any adapter is invoked.
 */
export class RoutedAiGateway implements AiGateway {
  readonly #connectors: readonly ConnectorDefinition[];
  readonly #adapters: ReadonlyMap<string, AiProviderAdapter>;
  readonly #policies: readonly RoutingPolicy[];

  constructor(input: {
    readonly connectors: readonly ConnectorDefinition[];
    readonly adapters: ReadonlyMap<string, AiProviderAdapter>;
    readonly policies?: readonly RoutingPolicy[];
  }) {
    this.#connectors = input.connectors;
    this.#adapters = input.adapters;
    this.#policies = input.policies ?? [];
  }

  async invoke(intent: AiInvocationIntent): Promise<AiProposal> {
    const intentValidation = validateAiInvocationIntent(intent);
    if (!intentValidation.valid) {
      throw new RoutedAiGatewayError(
        'AI_INTENT_INVALID',
        intentValidation.issues.map((issue) => issue.code).join(','),
      );
    }

    const capabilityKey = aiCapabilityKey(intent.operation);
    const policy = this.#policies.find(
      (candidate) =>
        candidate.tenantId === intent.tenantId
        && candidate.capabilityKey === capabilityKey,
    );
    const route = routeConnector(
      {
        tenantId: intent.tenantId,
        capabilityKey,
        requiredResidencyTags: intent.governance.requiredResidencyTags,
        requiredComplianceTags: intent.governance.requiredComplianceTags,
      },
      this.#connectors,
      policy,
    );
    if (route.connector === null) {
      throw new RoutedAiGatewayError(
        'AI_CONNECTOR_UNAVAILABLE',
        `No compliant connector is available: ${route.reason}.`,
      );
    }

    const adapter = this.#adapters.get(route.connector.connectorKey);
    if (adapter === undefined) {
      throw new RoutedAiGatewayError(
        'AI_ADAPTER_NOT_REGISTERED',
        `No adapter is registered for ${route.connector.connectorKey}.`,
      );
    }

    const proposal = await adapter.invoke({
      intent,
      connector: route.connector,
    });
    const proposalValidation = validateAiProposal(intent, proposal);
    if (!proposalValidation.valid) {
      throw new RoutedAiGatewayError(
        'AI_PROPOSAL_INVALID',
        proposalValidation.issues.map((issue) => issue.code).join(','),
      );
    }

    const maximumCost = intent.governance.maximumCostMinorUnits;
    const actualCost = proposal.provenance.costMinorUnits;
    if (
      maximumCost !== undefined
      && actualCost !== undefined
      && actualCost > maximumCost
    ) {
      throw new RoutedAiGatewayError(
        'AI_COST_LIMIT_EXCEEDED',
        `AI cost ${actualCost} exceeds the invocation ceiling ${maximumCost}.`,
      );
    }
    return proposal;
  }
}

export function aiCapabilityKey(operation: AiOperation): string {
  return `ai.${operation.toLocaleLowerCase()}`;
}
