import type { CommunicationProviderWebhookRequest } from './provider-webhook.ts';
import type { VoiceCallDirection, VoiceCallState } from './voice-transport.ts';

export interface CommunicationProviderVoiceEvent {
  readonly providerEventId: string;
  readonly connectorKey: string;
  readonly providerCallId: string;
  readonly state: VoiceCallState;
  readonly occurredAt: string;
  readonly direction?: VoiceCallDirection;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly recordingRef?: string;
  readonly transcriptRef?: string;
  readonly reasonCode?: string;
}

export type CommunicationProviderVoiceWebhookNormalizationResult =
  | {
      readonly verified: true;
      readonly events: readonly CommunicationProviderVoiceEvent[];
    }
  | {
      readonly verified: false;
      readonly reasonCode: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID';
      readonly reason?: string;
    };

/**
 * Concrete telephony adapters verify signatures and map provider payloads into
 * transport-only events. STT/TTS/semantic payloads do not enter this contract.
 */
export interface CommunicationProviderVoiceWebhookNormalizer {
  readonly adapterKey: string;
  verifyAndNormalize(
    request: CommunicationProviderWebhookRequest,
  ): Promise<CommunicationProviderVoiceWebhookNormalizationResult>;
}
