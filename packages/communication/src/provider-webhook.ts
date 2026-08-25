import type { CommunicationChannel } from './index.ts';
import type { CommunicationDeliveryState } from './delivery-state.ts';

export type CommunicationProviderWebhookState = Extract<
  CommunicationDeliveryState,
  'SENT' | 'DELIVERED' | 'FAILED' | 'BOUNCED' | 'COMPLAINED'
>;

export interface CommunicationProviderWebhookRequest {
  readonly connectorKey: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: Uint8Array;
}

export interface CommunicationProviderDeliveryEvent {
  readonly providerEventId: string;
  readonly connectorKey: string;
  readonly providerMessageId: string;
  readonly channel: CommunicationChannel;
  readonly state: CommunicationProviderWebhookState;
  readonly occurredAt: string;
  readonly reasonCode?: string;
  readonly reason?: string;
}

export type CommunicationProviderWebhookNormalizationResult =
  | {
      readonly verified: true;
      readonly events: readonly CommunicationProviderDeliveryEvent[];
    }
  | {
      readonly verified: false;
      readonly reasonCode: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID';
      readonly reason?: string;
    };

/**
 * Concrete provider webhook adapters own signature verification and payload
 * parsing. Core receives only verified, provider-neutral delivery events.
 */
export interface CommunicationProviderWebhookNormalizer {
  readonly adapterKey: string;
  verifyAndNormalize(
    request: CommunicationProviderWebhookRequest,
  ): Promise<CommunicationProviderWebhookNormalizationResult>;
}
