import type { CommunicationDeliveryRepository } from './delivery-repository.ts';
import type {
  CommunicationProviderWebhookNormalizer,
  CommunicationProviderWebhookRequest,
} from './provider-webhook.ts';

export type CommunicationWebhookIngestionResult =
  | {
      readonly accepted: false;
      readonly reasonCode: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID';
      readonly reason?: string;
    }
  | {
      readonly accepted: true;
      readonly applied: number;
      readonly duplicateOrNoop: number;
      readonly unmatched: number;
      readonly ignoredRegressions: number;
    };

/**
 * Provider-neutral webhook ingestion. Endpoint routing supplies tenantId and
 * the connector-specific normalizer; the normalizer must verify signatures
 * before any delivery lookup or mutation occurs.
 */
export async function ingestCommunicationProviderWebhook(input: {
  readonly tenantId: string;
  readonly request: CommunicationProviderWebhookRequest;
  readonly normalizer: CommunicationProviderWebhookNormalizer;
  readonly deliveryRepository: CommunicationDeliveryRepository;
}): Promise<CommunicationWebhookIngestionResult> {
  const normalized = await input.normalizer.verifyAndNormalize(input.request);
  if (!normalized.verified) {
    return {
      accepted: false,
      reasonCode: normalized.reasonCode,
      ...(normalized.reason === undefined ? {} : { reason: normalized.reason }),
    };
  }

  let applied = 0;
  let duplicateOrNoop = 0;
  let unmatched = 0;
  let ignoredRegressions = 0;

  for (const event of normalized.events) {
    const delivery = await input.deliveryRepository.findByProviderMessageId({
      tenantId: input.tenantId,
      connectorKey: event.connectorKey,
      providerMessageId: event.providerMessageId,
    });
    if (delivery === null) {
      unmatched += 1;
      continue;
    }

    try {
      const result = await input.deliveryRepository.applyTransition({
        tenantId: input.tenantId,
        deliveryId: delivery.deliveryId,
        providerMessageId: event.providerMessageId,
        transition: {
          from: delivery.state,
          to: event.state,
          occurredAt: event.occurredAt,
          providerEventId: event.providerEventId,
          ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      });
      if (result.applied) applied += 1;
      else duplicateOrNoop += 1;
    } catch (error) {
      if (isDeliveryRegression(error)) {
        ignoredRegressions += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    accepted: true,
    applied,
    duplicateOrNoop,
    unmatched,
    ignoredRegressions,
  };
}

function isDeliveryRegression(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('COMMUNICATION_DELIVERY_TRANSITION_INVALID:')
    || error.message.startsWith('COMMUNICATION_DELIVERY_STALE_FROM_STATE:');
}
