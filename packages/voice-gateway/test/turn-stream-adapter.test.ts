import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnStreamConversationAdapter } from '../src/turn-stream-adapter.ts';
import { withStreamConversationPlaceholders } from '../src/adapter-map.ts';
import { UnimplementedStreamConversationAdapter } from '../src/stream-conversation-adapter.ts';

test('Twilio stream connectors use the turn adapter', () => {
  const map = withStreamConversationPlaceholders(new Map(), [
    {
      connectorKey: 'twilio-voice',
      providerType: 'voice',
      providerKey: 'twilio',
      ownership: 'TENANT',
      enabled: true,
      health: 'HEALTHY',
      capabilityKeys: ['voice.stream_conversation'],
      tenantId: 't1',
    } as never,
  ]);
  assert.equal(map.get('twilio-voice') instanceof TurnStreamConversationAdapter, true);
});

test('unknown stream connectors stay unimplemented', () => {
  const map = withStreamConversationPlaceholders(new Map(), [
    {
      connectorKey: 'voice-stream-1',
      providerType: 'voice',
      providerKey: 'none',
      ownership: 'PLATFORM',
      enabled: true,
      health: 'HEALTHY',
      capabilityKeys: ['voice.stream_conversation'],
      tenantId: null,
    } as never,
  ]);
  assert.equal(map.get('voice-stream-1') instanceof UnimplementedStreamConversationAdapter, true);
});

test('turn adapter returns a STREAM observation', async () => {
  const adapter = new TurnStreamConversationAdapter();
  const observation = await adapter.invoke({
    intent: {
      requestId: 'r1',
      tenantId: 't1',
      callId: 'c1',
      operation: 'STREAM_CONVERSATION',
      purpose: 'turn',
      inputReference: 'book tomorrow at ten',
      languageTag: 'en-US',
      governance: {
        recordingConsentEvidenceReference: 'consent:1',
        recordingRetentionPolicy: { key: 'rec', version: 1 },
        transcriptRetentionPolicy: { key: 'tr', version: 1 },
        redactionPolicy: { key: 'red', version: 1 },
        jurisdictionTags: ['CA'],
        requiredResidencyTags: [],
        requiredComplianceTags: [],
      },
      idempotencyKey: 'id1',
      requestedAt: new Date().toISOString(),
    },
    connector: {
      connectorKey: 'twilio-voice',
      providerType: 'voice',
      providerKey: 'twilio',
      ownership: 'TENANT',
      enabled: true,
      health: 'HEALTHY',
      capabilityKeys: ['voice.stream_conversation'],
      tenantId: 't1',
    } as never,
  });
  assert.equal(observation.operation, 'STREAM_CONVERSATION');
  assert.match(observation.outputReference, /book tomorrow/);
});
