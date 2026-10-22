import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withStreamConversationPlaceholders } from '../src/adapter-map.ts';
import { UnimplementedStreamConversationAdapter } from '../src/stream-conversation-adapter.ts';

test('places unimplemented stream adapter on stream connectors only', () => {
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
    {
      connectorKey: 'voice-stt-1',
      providerType: 'voice',
      providerKey: 'deepgram',
      ownership: 'PLATFORM',
      enabled: true,
      health: 'HEALTHY',
      capabilityKeys: ['voice.transcribe'],
      tenantId: null,
    } as never,
  ]);
  assert.equal(map.has('voice-stream-1'), true);
  assert.equal(map.get('voice-stream-1') instanceof UnimplementedStreamConversationAdapter, true);
  assert.equal(map.has('voice-stt-1'), false);
});
