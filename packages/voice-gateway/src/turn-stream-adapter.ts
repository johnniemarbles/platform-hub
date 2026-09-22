import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { VoiceIntelligenceIntent, VoiceIntelligenceObservation } from './index.ts';
import type { VoiceProviderAdapter } from './routing.ts';

/**
 * STREAM_CONVERSATION for connectors that deliver one utterance at a time
 * (Twilio ConversationRelay prompt events, or a media-stream sidecar that
 * already ran STT). Audio bytes are not decoded here; inputReference is the
 * caller text for this turn. The Platform live loop owns tools + GENERATE.
 */
export class TurnStreamConversationAdapter implements VoiceProviderAdapter {
  readonly adapterKey = 'voice-stream-turn';

  async invoke(input: {
    readonly intent: VoiceIntelligenceIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<VoiceIntelligenceObservation> {
    const text = input.intent.inputReference.trim();
    return {
      requestId: input.intent.requestId,
      tenantId: input.intent.tenantId,
      callId: input.intent.callId,
      operation: 'STREAM_CONVERSATION',
      outputReference: text.slice(0, 8000),
      provenance: {
        connectorKey: input.connector.connectorKey,
        providerKey: input.connector.providerKey,
        modelKey: 'expadio.voice.stream.turn',
        sourceReferences: [input.intent.inputReference],
        processedAt: new Date().toISOString(),
      },
    };
  }
}
