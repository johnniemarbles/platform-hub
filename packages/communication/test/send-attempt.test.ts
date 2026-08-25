import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommunicationSendAttempt } from '../src/send-attempt.ts';
import { StaticCommunicationProviderAdapterRegistry } from '../src/provider-adapter-registry.ts';
import type {
  CommunicationDeliveryRecord,
  CommunicationDeliveryRepository,
} from '../src/delivery-repository.ts';
import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from '../src/provider-adapter.ts';

const connector = {
  connectorKey: 'email-primary',
  providerType: 'email',
  providerKey: 'provider-a',
  ownership: 'TENANT' as const,
};

const request: CommunicationProviderSendRequest = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  triggerKey: 'lead.created',
  purpose: 'transactional',
  channel: 'email',
  recipient: { email: 'user@example.com' },
  recipientKey: 'email:user@example.com',
  rendered: {
    templateId: '11111111-1111-1111-1111-111111111111',
    version: 1,
    channel: 'email',
    locale: 'en',
    format: 'text',
    subject: 'Hello',
    body: 'World',
    variables: {},
  },
  idempotencyKey: 'idem-1',
  requestedAt: '2026-08-25T05:00:00.000Z',
};

const baseDelivery: CommunicationDeliveryRecord = {
  deliveryId: '22222222-2222-2222-2222-222222222222',
  tenantId: request.tenantId,
  idempotencyKey: request.idempotencyKey,
  channel: 'email',
  connectorKey: connector.connectorKey,
  adapterKey: 'provider-a-runtime',
  state: 'PENDING',
  attemptCount: 0,
  requestedAt: request.requestedAt,
  updatedAt: request.requestedAt,
};

function repository(overrides: Partial<CommunicationDeliveryRepository> = {}): CommunicationDeliveryRepository {
  return {
    async createOrGet() { return baseDelivery; },
    async findByIdempotencyKey() { return baseDelivery; },
    async findByProviderMessageId() { return null; },
    async recordAttempt() {
      return { ...baseDelivery, attemptCount: baseDelivery.attemptCount + 1 };
    },
    async applyTransition(input) {
      return {
        applied: true,
        delivery: {
          ...baseDelivery,
          state: input.transition.to,
          attemptCount: input.incrementAttempt === true
            ? baseDelivery.attemptCount + 1
            : baseDelivery.attemptCount,
          ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
        },
      };
    },
    ...overrides,
  };
}

function adapterRegistry(send: CommunicationProviderAdapter['send']) {
  return new StaticCommunicationProviderAdapterRegistry([{
    providerKey: connector.providerKey,
    adapter: {
      adapterKey: baseDelivery.adapterKey,
      supportedChannels: ['email'],
      send,
    },
  }]);
}

const retryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 };

test('accepts provider delivery and persists ACCEPTED exactly once', async () => {
  let transitionCount = 0;
  const result = await executeCommunicationSendAttempt({
    connector,
    request,
    registry: adapterRegistry(async (): Promise<CommunicationProviderSendResult> => ({
      status: 'ACCEPTED',
      reasonCode: 'OK',
      providerMessageId: 'provider-1',
      acceptedAt: '2026-08-25T05:01:00.000Z',
    })),
    deliveryRepository: repository({
      async applyTransition(input) {
        transitionCount += 1;
        return {
          applied: true,
          delivery: {
            ...baseDelivery,
            state: 'ACCEPTED',
            attemptCount: 1,
            ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
          },
        };
      },
    }),
    retryPolicy,
    attemptedAt: '2026-08-25T05:01:00.000Z',
  });

  assert.equal(result.outcome, 'ACCEPTED');
  assert.equal(transitionCount, 1);
});

test('records retryable failure without changing delivery state', async () => {
  let recordCount = 0;
  const result = await executeCommunicationSendAttempt({
    connector,
    request,
    registry: adapterRegistry(async (): Promise<CommunicationProviderSendResult> => ({
      status: 'RETRYABLE_FAILURE',
      reasonCode: 'RATE_LIMITED',
      retryAfterMs: 4000,
    })),
    deliveryRepository: repository({
      async recordAttempt() {
        recordCount += 1;
        return { ...baseDelivery, attemptCount: 1, lastReasonCode: 'RATE_LIMITED' };
      },
    }),
    retryPolicy,
    attemptedAt: '2026-08-25T05:01:00.000Z',
  });

  assert.equal(result.outcome, 'RETRY');
  if (result.outcome === 'RETRY') {
    assert.equal(result.delivery.state, 'PENDING');
    assert.equal(result.delayMs, 4000);
    assert.equal(result.nextAttempt, 1);
  }
  assert.equal(recordCount, 1);
});

test('does not invoke provider again for an already-processed idempotency key', async () => {
  let sends = 0;
  const result = await executeCommunicationSendAttempt({
    connector,
    request,
    registry: adapterRegistry(async (): Promise<CommunicationProviderSendResult> => {
      sends += 1;
      return { status: 'ACCEPTED', reasonCode: 'OK' };
    }),
    deliveryRepository: repository({
      async createOrGet() { return { ...baseDelivery, state: 'ACCEPTED' }; },
    }),
    retryPolicy,
    attemptedAt: '2026-08-25T05:01:00.000Z',
  });

  assert.equal(result.outcome, 'ALREADY_PROCESSED');
  assert.equal(sends, 0);
});

test('rejects idempotency reuse that resolves to a different connector or adapter', async () => {
  let sends = 0;
  const result = await executeCommunicationSendAttempt({
    connector,
    request,
    registry: adapterRegistry(async (): Promise<CommunicationProviderSendResult> => {
      sends += 1;
      return { status: 'ACCEPTED', reasonCode: 'OK' };
    }),
    deliveryRepository: repository({
      async createOrGet() {
        return { ...baseDelivery, connectorKey: 'other-connector' };
      },
    }),
    retryPolicy,
    attemptedAt: '2026-08-25T05:01:00.000Z',
  });

  assert.equal(result.outcome, 'IDEMPOTENCY_ROUTE_MISMATCH');
  assert.equal(sends, 0);
});
