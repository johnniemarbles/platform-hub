import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { VoiceProviderAdapter } from './routing.ts';
import { UnimplementedStreamConversationAdapter } from './stream-conversation-adapter.ts';

/**
 * Registers a fail-closed STREAM_CONVERSATION adapter for any connector that
 * advertises voice.stream_conversation so routing never looks live.
 */
export function withStreamConversationPlaceholders(
  adapters: ReadonlyMap<string, VoiceProviderAdapter>,
  connectors: readonly ConnectorDefinition[],
): Map<string, VoiceProviderAdapter> {
  const next = new Map(adapters);
  const placeholder = new UnimplementedStreamConversationAdapter();
  for (const connector of connectors) {
    const keys = connector.capabilityKeys ?? [];
    if (keys.includes('voice.stream_conversation') && !next.has(connector.connectorKey)) {
      next.set(connector.connectorKey, placeholder);
    }
  }
  return next;
}
