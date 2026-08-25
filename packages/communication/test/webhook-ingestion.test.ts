import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestCommunicationProviderWebhook } from '../src/webhook-ingestion.ts';
import type { CommunicationDeliveryRepository } from '../src/delivery-repository.ts';
import type { CommunicationProviderWebhookNormalizer } from '../src/provider-webhook.ts';

const request = { connectorKey: 'email-primary', headers: {}, rawBody: new Uint8Array() };
const delivery = {
  deliveryId: '11111111-1111-1111-1111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  idempotencyKey: 'idem-1',
  channel: 'email' as const,
  connectorKey: 'email-primary',
  adapterKey: 'email-runtime',
  providerMessageId: 'provider-1',
  state: 'SENT' as const,
  attemptCount: 1,
  requestedAt: '2026-08-25T05:00:00.000Z',
  updatedAt: '2026-08-25T05:01:00.000Z',
};

function repository(overrides: Partial<CommunicationDeliveryRepository> = {}): CommunicationDeliveryRepository {
  return {
    async createOrGet() { return delivery; },
    async findByIdempotencyKey() { return delivery; },
    async findByProviderMessageId() { return delivery; },
    async recordAttempt() { return delivery; },
    async applyTransition(input) {
      return { applied: true, delivery: { ...delivery, state: input.transition.to } };
    },
    ...overrides,
  };
}

const verifiedNormalizer: CommunicationProviderWebhookNormalizer = {
  adapterKey: 'email-webhook',
  async verifyAndNormalize() {
    return {
      verified: true,
      events: [{
        providerEventId: 'event-1',
        connectorKey: 'email-primary',
        providerMessageId: 'provider-1',
        channel: 'email',
        state: 'DELIVERED',
        occurredAt: '2026-08-25T05:02:00.000Z',
      }],
    };
  },
};

test('rejects unverified webhooks before delivery lookup', async () => {
  let lookedUp = false;
  const result = await ingestCommunicationProviderWebhook({
    tenantId: delivery.tenantId,
    request,
    normalizer: {
      adapterKey: 'bad',
      async verifyAndNormalize() {
        return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID' };
      },
    },
    deliveryRepository: repository({
      async findByProviderMessageId() { lookedUp = true; return delivery; },
    }),
  });
  assert.equal(result.accepted, false);
  assert.equal(lookedUp, false);
});

test('applies verified provider events through the delivery repository', async () => {
  const result = await ingestCommunicationProviderWebhook({
    tenantId: delivery.tenantId,
    request,
    normalizer: verifiedNormalizer,
    deliveryRepository: repository(),
  });
  assert.deepEqual(result, {
    accepted: true,
    applied: 1,
    duplicateOrNoop: 0,
    unmatched: 0,
    ignoredRegressions: 0,
  });
});

test('counts unmatched and duplicate/no-op events without failing the webhook', async () => {
  const unmatched = await ingestCommunicationProviderWebhook({
    tenantId: delivery.tenantId,
    request,
    normalizer: verifiedNormalizer,
    deliveryRepository: repository({ async findByProviderMessageId() { return null; } }),
  });
  assert.equal(unmatched.accepted && unmatched.unmatched, 1);

  const duplicate = await ingestCommunicationProviderWebhook({
    tenantId: delivery.tenantId,
    request,
    normalizer: verifiedNormalizer,
    deliveryRepository: repository({ async applyTransition() { return { applied: false, delivery }; } }),
  });
  assert.equal(duplicate.accepted && duplicate.duplicateOrNoop, 1);
});

test('ignores stale/regressive provider callbacks but propagates unrelated failures', async () => {
  const regression = await ingestCommunicationProviderWebhook({
    tenantId: delivery.tenantId,
    request,
    normalizer: verifiedNormalizer,
    deliveryRepository: repository({
      async applyTransition() { throw new Error('COMMUNICATION_DELIVERY_TRANSITION_INVALID:DELIVERED->SENT'); },
    }),
  });
  assert.equal(regression.accepted && regression.ignoredRegressions, 1);

  await assert.rejects(
    () => ingestCommunicationProviderWebhook({
      tenantId: delivery.tenantId,
      request,
      normalizer: verifiedNormalizer,
      deliveryRepository: repository({ async applyTransition() { throw new Error('database down'); } }),
    }),
    /database down/,
  );
});
