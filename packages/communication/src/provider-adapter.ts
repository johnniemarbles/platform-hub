import type {
  CommunicationChannel,
  CommunicationPurpose,
  CommunicationRecipient,
} from './index.ts';
import type { RenderedCommunicationTemplate } from './template-renderer.ts';

export interface CommunicationProviderSender {
  readonly senderKey: string;
  readonly address?: string;
  readonly displayName?: string;
  readonly replyTo?: string;
}

export interface CommunicationProviderSendRequest {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly purpose: CommunicationPurpose;
  readonly channel: CommunicationChannel;
  readonly recipient: CommunicationRecipient;
  readonly recipientKey: string;
  readonly sender?: CommunicationProviderSender;
  readonly rendered: RenderedCommunicationTemplate;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type CommunicationProviderSendStatus =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'RETRYABLE_FAILURE';

export type CommunicationProviderSendReasonCode =
  | 'OK'
  | 'RATE_LIMITED'
  | 'INVALID_RECIPIENT'
  | 'SENDER_REJECTED'
  | 'AUTHENTICATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED';

export interface CommunicationProviderSendResult {
  readonly status: CommunicationProviderSendStatus;
  readonly reasonCode: CommunicationProviderSendReasonCode;
  readonly providerMessageId?: string;
  readonly acceptedAt?: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
}

/**
 * Channel/provider adapter contract. Concrete adapters are runtime-bound to a
 * selected connector and its secret reference; credentials and provider config
 * never enter this request contract.
 */
export interface CommunicationProviderAdapter {
  readonly adapterKey: string;
  readonly supportedChannels: readonly CommunicationChannel[];
  send(request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult>;
}
