import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import {
  RoutedAiGateway,
  RoutedAiGatewayError,
  aiCapabilityKey,
  governedAiApiTokenProvider,
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

for (const scenario of ['missing', 'disabled', 'unhealthy', 'wrong-tenant', 'allow-listed-platform'] as const) {
  test(`tenant BYOK refuses ${scenario} without invoking any adapter`, async () => {
    let calls = 0;
    const shared = { ...platformConnector, fallbackEnabled: true };
    const own = scenario === 'disabled' ? { ...tenantConnector, enabled: false }
      : scenario === 'unhealthy' ? { ...tenantConnector, health: 'UNHEALTHY' as const }
      : { ...tenantConnector, tenantId: 'another-tenant' };
    const adapter: AiProviderAdapter = { async invoke({ connector }) { calls++; return proposal(connector); } };
    const gateway = new RoutedAiGateway({
      connectors: [shared, ...(scenario === 'missing' || scenario === 'allow-listed-platform' ? [] : [own])],
      adapters: new Map([[shared.connectorKey, adapter], [own.connectorKey, adapter]]),
      policies: scenario === 'allow-listed-platform'
        ? [{ tenantId: intent.tenantId, capabilityKey: 'ai.extract', allowedConnectorKeys: [shared.connectorKey] }]
        : [],
    });
    await assert.rejects(() => gateway.invoke(intent), (error: unknown) =>
      error instanceof RoutedAiGatewayError && error.code === 'AI_CONNECTOR_UNAVAILABLE');
    assert.equal(calls, 0);
  });
}

test('tenant BYOK takes precedence even when platform priority is better and tenant preference is false', async () => {
  const invoked: string[] = [];
  const adapter: AiProviderAdapter = { async invoke({ connector }) {
    invoked.push(connector.connectorKey); return proposal(connector);
  } };
  const gateway = new RoutedAiGateway({
    connectors: [{ ...platformConnector, fallbackEnabled: true }, tenantConnector],
    adapters: new Map([[platformConnector.connectorKey, adapter], [tenantConnector.connectorKey, adapter]]),
    policies: [{ tenantId: intent.tenantId, capabilityKey: 'ai.extract', preferTenantOwned: false }],
  });
  await gateway.invoke(intent);
  assert.deepEqual(invoked, [tenantConnector.connectorKey]);
});

for (const connector of [platformConnector, { ...tenantConnector, tenantId: 'another-tenant' },
  { ...tenantConnector, enabled: false }, { ...tenantConnector, health: 'UNHEALTHY' as const }]) {
  test(`credential boundary refuses ${connector.ownership}/${connector.tenantId}/${connector.enabled}/${connector.health} before custody access`, async () => {
    let accesses = 0;
    const forbidden = async (): Promise<never> => { accesses++; throw new Error('Custody must not be accessed'); };
    const token = governedAiApiTokenProvider({
      connectors: [connector], credentialRepository: { loadCredentialReference: forbidden },
      leaseService: { issue: forbidden }, secretResolver: { resolve: forbidden },
      requestedBySubjectId: 'user-1', requestId: () => 'request-1', correlationId: () => 'correlation-1',
    });
    await assert.rejects(() => token({
      connectorKey: connector.connectorKey, tenantId: intent.tenantId,
      operation: intent.operation, purpose: intent.purpose,
      idempotencyKey: intent.idempotencyKey, requestedAt: intent.requestedAt,
    }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'AI_CONNECTOR_INVALID');
    assert.equal(accesses, 0);
  });
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
  const costConnector: ConnectorDefinition = tenantConnector;
  const gateway = new RoutedAiGateway({
    connectors: [costConnector],
    adapters: new Map([[costConnector.connectorKey, adapter]]),
  });

  await assert.rejects(
    () => gateway.invoke(intent),
    (error: unknown) =>
      error instanceof RoutedAiGatewayError
      && error.code === 'AI_COST_LIMIT_EXCEEDED',
  );
});
