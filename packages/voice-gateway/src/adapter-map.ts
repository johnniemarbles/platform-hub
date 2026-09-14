import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { VoiceProviderAdapter } from './routing.ts';
import { UnimplementedStreamConversationAdapter } from './stream-conversation-adapter.ts';
import { TurnStreamConversationAdapter } from './turn-stream-adapter.ts';

function isTwilioVoice(connector: ConnectorDefinition): boolean {
  return connector.providerKey === 'twilio'
    || connector.providerKey === 'twilio-voice'
    || connector.connectorKey.includes('twilio');
}

/**
 * STREAM_CONVERSATION: Twilio gets the turn adapter (ConversationRelay / sidecar).
 * Every other stream connector stays fail-closed until a realtime adapter exists.
 */
export function withStreamConversationPlaceholders(
  adapters: ReadonlyMap<string, VoiceProviderAdapter>,
  connectors: readonly ConnectorDefinition[],
): Map<string, VoiceProviderAdapter> {
  const next = new Map(adapters);
  const unimplemented = new UnimplementedStreamConversationAdapter();
  const turn = new TurnStreamConversationAdapter();
  for (const connector of connectors) {
    const keys = connector.capabilityKeys ?? [];
    if (!keys.includes('voice.stream_conversation') || next.has(connector.connectorKey)) continue;
    next.set(connector.connectorKey, isTwilioVoice(connector) ? turn : unimplemented);
  }
  return next;
}
