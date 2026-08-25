import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import {
  RoutedVoiceGateway,
  RoutedVoiceGatewayError,
  voiceCapabilityKey,
  type VoiceIntelligenceIntent,
  type VoiceIntelligenceObservation,
  type VoiceProviderAdapter,
} from '../src/index.ts';

const intent: VoiceIntelligenceIntent = {
  requestId: 'request-1',
  tenantId: 'tenant-1',
  callId: 'call-1',
  operation: 'TRANSCRIBE',
  purpose: 'Create a governed transcript.',
  inputReference: 'object://tenant-1/call-1/audio',
  languageTag: 'en-CA',
  governance: {
    recordingConsentEvidenceReference: 'consent://call-1/recording',
    recordingRetentionPolicy: { key: 'recording', version: 1 },
    transcriptRetentionPolicy: { key: 'transcript', version: 1 },
    redactionPolicy: { key: 'redaction', version: 1 },
    jurisdictionTags: ['CA-ON'],
    requiredResidencyTags: ['ca'],
    requiredComplianceTags: ['regulated'],
    maximumCostMinorUnits: 10,
  },
  idempotencyKey: 'transcribe:call-1',
  requestedAt: '2026-08-25T15:00:00.000Z',
};

const connector: ConnectorDefinition = {
  connectorKey: 'tenant-stt',
  providerType: 'voice-intelligence',
  providerKey: 'customer-provider',
  ownership: 'TENANT',
  tenantId: 'tenant-1',
  capabilityKeys: ['voice.transcribe'],
  residencyTags: ['ca'],
  complianceTags: ['regulated'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};

function observation(cost = 5): VoiceIntelligenceObservation {
  return {
    requestId: intent.requestId,
    tenantId: intent.tenantId,
    callId: intent.callId,
    operation: intent.operation,
    outputReference: 'object://tenant-1/call-1/transcript',
    provenance: {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: 'stt-model',
      sourceReferences: [intent.inputReference],
      processedAt: '2026-08-25T15:00:02.000Z',
      audioDurationMilliseconds: 60000,
      costMinorUnits: cost,
    },
  };
}

test('maps voice operations to provider-registry capabilities', () => {
  assert.equal(
    voiceCapabilityKey('STREAM_CONVERSATION'),
    'voice.stream_conversation',
  );
});

test('routes only through a compliant registered voice adapter', async () => {
  const invoked: string[] = [];
  const adapter: VoiceProviderAdapter = {
    async invoke({ connector: selected }) {
      invoked.push(selected.connectorKey);
      return observation();
    },
  };
  const gateway = new RoutedVoiceGateway({
    connectors: [connector],
    adapters: new Map([['tenant-stt', adapter]]),
  });

  const result = await gateway.invoke(intent);
  assert.equal(result.provenance.connectorKey, 'tenant-stt');
  assert.deepEqual(invoked, ['tenant-stt']);
});

test('fails before invocation when residency is not satisfied', async () => {
  const gateway = new RoutedVoiceGateway({
    connectors: [{ ...connector, residencyTags: ['us'] }],
    adapters: new Map(),
  });

  await assert.rejects(
    () => gateway.invoke(intent),
    (error: unknown) =>
      error instanceof RoutedVoiceGatewayError
      && error.code === 'VOICE_CONNECTOR_UNAVAILABLE',
  );
});

test('fails closed when voice cost exceeds the request ceiling', async () => {
  const adapter: VoiceProviderAdapter = {
    async invoke() {
      return observation(11);
    },
  };
  const gateway = new RoutedVoiceGateway({
    connectors: [connector],
    adapters: new Map([['tenant-stt', adapter]]),
  });

  await assert.rejects(
    () => gateway.invoke(intent),
    (error: unknown) =>
      error instanceof RoutedVoiceGatewayError
      && error.code === 'VOICE_COST_LIMIT_EXCEEDED',
  );
});
