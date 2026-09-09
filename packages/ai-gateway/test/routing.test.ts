import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import {
  RoutedAiGateway,
  RoutedAiGatewayError,
  aiCapabilityKey,
  type AiInvocationIntent,
  type AiProposal,
  type AiProviderAdapter,
} from '../src/index.ts';

const intent: AiInvocationIntent = {
  invocationId: 'invocation-1',
  tenantId: 'tenant-1',
  operation: 'EXTRACT',
  purpose: 'Extract facts for review.',
  inputReference: 'object://tenant-1/document-1',
  promptConfiguration: { key: 'extract-facts', version: 2 },
  governance: {
    requiredResidencyTags: ['eu'],
    requiredComplianceTags: ['regulated'],
    maximumCostMinorUnits: 10,
  },
  idempotencyKey: 'extract:document-1:v2',
  requestedAt: '2026-08-25T15:00:00.000Z',
};

const platformConnector: ConnectorDefinition = {
  connectorKey: 'platform-ai',
  providerType: 'ai',
  providerKey: 'platform-provider',
  ownership: 'PLATFORM',
  capabilityKeys: ['ai.extract'],
  residencyTags: ['eu'],
  complianceTags: ['regulated'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};

const tenantConnector: ConnectorDefinition = {
  ...platformConnector,
  connectorKey: 'tenant-ai',
  providerKey: 'customer-provider',
  ownership: 'TENANT',
  tenantId: 'tenant-1',
  priority: 5,
};

function proposal(connector: ConnectorDefinition, cost = 4): AiProposal {
  return {
    invocationId: intent.invocationId,
    tenantId: intent.tenantId,
    status: 'PROPOSAL',
    outputReference: 'object://tenant-1/output-1',
    confidence: 0.9,
    provenance: {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: 'model-1',
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [intent.inputReference],
      processedAt: '2026-08-25T15:00:01.000Z',
      costMinorUnits: cost,
    },
  };
}

test('maps AI operations to provider-registry capabilities', () => {
  assert.equal(aiCapabilityKey('VISION_ANALYZE'), 'ai.vision_analyze');
});

test('routes through the compliant tenant-owned adapter when policy prefers it', async () => {
  const invoked: string[] = [];
  const adapter: AiProviderAdapter = {
    async invoke({ connector }) {
      invoked.push(connector.connectorKey);
      return proposal(connector);
    },
  };
  const gateway = new RoutedAiGateway({
    connectors: [platformConnector, tenantConnector],
    adapters: new Map([['tenant-ai', adapter]]),
    policies: [{
      tenantId: 'tenant-1',
      capabilityKey: 'ai.extract',
      preferTenantOwned: true,
    }],
  });

  const result = await gateway.invoke(intent);
  assert.equal(result.provenance.connectorKey, 'tenant-ai');
  assert.deepEqual(invoked, ['tenant-ai']);
});

test('fails before invocation when no compliant connector exists', async () => {
  const gateway = new RoutedAiGateway({
    connectors: [{
      ...platformConnector,
      complianceTags: [],
    }],
    adapters: new Map(),
  });

  await assert.rejects(
    () => gateway.invoke(intent),
    (error: unknown) =>
      error instanceof RoutedAiGatewayError
      && error.code === 'AI_CONNECTOR_UNAVAILABLE',
  );
});

test('fails closed when the provider reports cost over the ceiling', async () => {
  const adapter: AiProviderAdapter = {
    async invoke({ connector }) {
      return proposal(connector, 11);
    },
  };
  // fallbackEnabled:true makes the PLATFORM connector visible without a tenant policy
  const costConnector: ConnectorDefinition = { ...platformConnector, fallbackEnabled: true };
  const gateway = new RoutedAiGateway({
    connectors: [costConnector],
    adapters: new Map([['platform-ai', adapter]]),
  });

  await assert.rejects(
    () => gateway.invoke(intent),
    (error: unknown) =>
      error instanceof RoutedAiGatewayError
      && error.code === 'AI_COST_LIMIT_EXCEEDED',
  );
});
