import {
  routeConnector,
  type ConnectorDefinition,
  type RoutingPolicy,
} from '@platform-hub/provider-registry';
import {
  validateVoiceIntelligenceIntent,
  validateVoiceIntelligenceObservation,
  type VoiceGateway,
  type VoiceIntelligenceIntent,
  type VoiceIntelligenceObservation,
  type VoiceIntelligenceOperation,
} from './index.ts';

export interface VoiceProviderAdapter {
  invoke(input: {
    readonly intent: VoiceIntelligenceIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<VoiceIntelligenceObservation>;
}

export type RoutedVoiceGatewayErrorCode =
  | 'VOICE_INTENT_INVALID'
  | 'VOICE_CONNECTOR_UNAVAILABLE'
  | 'VOICE_ADAPTER_NOT_REGISTERED'
  | 'VOICE_OBSERVATION_INVALID'
  | 'VOICE_COST_EVIDENCE_REQUIRED'
  | 'VOICE_COST_LIMIT_EXCEEDED';

export class RoutedVoiceGatewayError extends Error {
  readonly code: RoutedVoiceGatewayErrorCode;
  constructor(code: RoutedVoiceGatewayErrorCode, message: string) {
    super(message);
    this.name = 'RoutedVoiceGatewayError';
    this.code = code;
  }
}

export class RoutedVoiceGateway implements VoiceGateway {
  readonly #connectors: readonly ConnectorDefinition[];
  readonly #adapters: ReadonlyMap<string, VoiceProviderAdapter>;
  readonly #policies: readonly RoutingPolicy[];

  constructor(input: {
    readonly connectors: readonly ConnectorDefinition[];
    readonly adapters: ReadonlyMap<string, VoiceProviderAdapter>;
    readonly policies?: readonly RoutingPolicy[];
  }) {
    this.#connectors = input.connectors;
    this.#adapters = input.adapters;
    this.#policies = input.policies ?? [];
  }

  async invoke(intent: VoiceIntelligenceIntent): Promise<VoiceIntelligenceObservation> {
    const validation = validateVoiceIntelligenceIntent(intent);
    if (!validation.valid) {
      throw new RoutedVoiceGatewayError(
        'VOICE_INTENT_INVALID',
        validation.issues.map((issue) => issue.code).join(','),
      );
    }

    const capabilityKey = voiceCapabilityKey(intent.operation);
    const policy = this.#policies.find(
      (candidate) => candidate.tenantId === intent.tenantId && candidate.capabilityKey === capabilityKey,
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
      throw new RoutedVoiceGatewayError(
        'VOICE_CONNECTOR_UNAVAILABLE',
        `No compliant voice connector is available: ${route.reason}.`,
      );
    }

    const adapter = this.#adapters.get(route.connector.connectorKey);
    if (adapter === undefined) {
      throw new RoutedVoiceGatewayError(
        'VOICE_ADAPTER_NOT_REGISTERED',
        `No voice adapter is registered for ${route.connector.connectorKey}.`,
      );
    }

    const observation = await adapter.invoke({ intent, connector: route.connector });
    const observationValidation = validateVoiceIntelligenceObservation(intent, observation);
    if (!observationValidation.valid) {
      throw new RoutedVoiceGatewayError(
        'VOICE_OBSERVATION_INVALID',
        observationValidation.issues.map((issue) => issue.code).join(','),
      );
    }

    const maximumCost = intent.governance.maximumCostMinorUnits;
    const actualCost = observation.provenance.costMinorUnits;
    if (maximumCost !== undefined && actualCost === undefined) {
      throw new RoutedVoiceGatewayError(
        'VOICE_COST_EVIDENCE_REQUIRED',
        'Provider cost evidence is required when a voice request has a cost ceiling.',
      );
    }
    if (maximumCost !== undefined && actualCost !== undefined && actualCost > maximumCost) {
      throw new RoutedVoiceGatewayError(
        'VOICE_COST_LIMIT_EXCEEDED',
        `Voice cost ${actualCost} exceeds the request ceiling ${maximumCost}.`,
      );
    }
    return observation;
  }
}

export function voiceCapabilityKey(operation: VoiceIntelligenceOperation): string {
  return `voice.${operation.toLocaleLowerCase()}`;
}
