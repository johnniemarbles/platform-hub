import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { VoiceIntelligenceIntent, VoiceIntelligenceObservation } from './index.ts';
import type { VoiceProviderAdapter } from './routing.ts';

export class StreamConversationUnimplementedError extends Error {
  readonly code = 'VOICE_STREAM_UNIMPLEMENTED';
  constructor() {
    super('STREAM_CONVERSATION has no realtime adapter. Use TRANSCRIBE + SYNTHESIZE or the voice simulator.');
    this.name = 'StreamConversationUnimplementedError';
  }
}

/** Fail-closed placeholder so routing cannot pretend streaming is live. */
export class UnimplementedStreamConversationAdapter implements VoiceProviderAdapter {
  readonly adapterKey = 'voice-stream-unimplemented';
  async invoke(_input: {
    readonly intent: VoiceIntelligenceIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<VoiceIntelligenceObservation> {
    throw new StreamConversationUnimplementedError();
  }
}
