import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  StreamConversationUnimplementedError,
  UnimplementedStreamConversationAdapter,
} from '../src/stream-conversation-adapter.ts';

test('stream conversation adapter fails closed', async () => {
  const adapter = new UnimplementedStreamConversationAdapter();
  await assert.rejects(
    () => adapter.invoke({
      intent: {
        requestId: 'r1', tenantId: 't1', callId: 'c1', operation: 'STREAM_CONVERSATION',
        purpose: 'test', inputReference: 'ref://audio/1', languageTag: 'en',
        governance: {
          recordingConsentEvidenceReference: 'ev',
          recordingRetentionPolicy: { key: 'rec', version: 1 },
          transcriptRetentionPolicy: { key: 'tr', version: 1 },
          redactionPolicy: { key: 'red', version: 1 },
          jurisdictionTags: ['CA'],
          requiredResidencyTags: [],
          requiredComplianceTags: [],
        },
        idempotencyKey: 'id', requestedAt: new Date().toISOString(),
      },
      connector: {
        connectorKey: 'voice-stream', providerType: 'voice', providerKey: 'none',
        ownership: 'PLATFORM', enabled: true, health: 'HEALTHY',
        capabilityKeys: ['voice.stream_conversation'], tenantId: null,
      } as never,
    }),
    (error: unknown) => error instanceof StreamConversationUnimplementedError,
  );
});
