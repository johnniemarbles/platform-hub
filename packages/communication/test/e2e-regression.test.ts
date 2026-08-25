import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommunicationSendAttempt } from '../src/send-attempt.ts';
import { ingestCommunicationProviderWebhook } from '../src/webhook-ingestion.ts';
import { StaticCommunicationProviderAdapterRegistry } from '../src/provider-adapter-registry.ts';
import type {
  ApplyCommunicationDeliveryTransitionInput,
  CommunicationDeliveryRecord,
  CommunicationDeliveryRepository,
  CreateCommunicationDeliveryInput,
  RecordCommunicationDeliveryAttemptInput,
} from '../src/delivery-repository.ts';
import type { CommunicationProviderSendRequest } from '../src/provider-adapter.ts';
import type { CommunicationProviderWebhookNormalizer } from '../src/provider-webhook.ts';
import { assertDeliveryTransition } from '../src/delivery-state.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const deliveryId = '22222222-2222-2222-2222-222222222222';
const connector = {
  connectorKey: 'email-primary',
  providerType: 'email',
  providerKey: 'provider-a',
  ownership: 'TENANT' as const,
};

class MemoryDeliveryRepository implements CommunicationDeliveryRepository {
  record: CommunicationDeliveryRecord | null = null;
  readonly providerEvents = new Set<string>();

  async createOrGet(input: CreateCommunicationDeliveryInput): Promise<CommunicationDeliveryRecord> {
    if (this.record !== null) return this.record;
    this.record = {
      deliveryId,
      tenantId: input.tenantId,
      ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      connectorKey: input.connectorKey,
      adapterKey: input.adapterKey,
      state: 'PENDING',
      attemptCount: 0,
      requestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    return this.record;
  }

  async findByIdempotencyKey(input: { tenantId: string; idempotencyKey: string }) {
    return this.record?.tenantId === input.tenantId
      && this.record.idempotencyKey === input.idempotencyKey
      ? this.record
      : null;
  }

  async findByProviderMessageId(input: {
    tenantId: string;
    connectorKey: string;
    providerMessageId: string;
  }) {
    return this.record?.tenantId === input.tenantId
      && this.record.connectorKey === input.connectorKey
      && this.record.providerMessageId === input.providerMessageId
      ? this.record
      : null;
  }

  async recordAttempt(input: RecordCommunicationDeliveryAttemptInput) {
    if (this.record === null || this.record.deliveryId !== input.deliveryId) throw new Error('missing delivery');
    this.record = {
      ...this.record,
      attemptCount: this.record.attemptCount + 1,
      lastReasonCode: input.reasonCode,
      ...(input.reason === undefined ? {} : { lastReason: input.reason }),
      updatedAt: input.occurredAt,
    };
    return this.record;
  }

  async applyTransition(input: ApplyCommunicationDeliveryTransitionInput) {
    if (this.record === null || this.record.deliveryId !== input.deliveryId) throw new Error('missing delivery');
    if (input.transition.providerEventId !== undefined) {
      if (this.providerEvents.has(input.transition.providerEventId)) {
        return { applied: false, delivery: this.record };
      }
      this.providerEvents.add(input.transition.providerEventId);
    }
    if (this.record.state !== input.transition.from) {
      throw new Error(`COMMUNICATION_DELIVERY_STALE_FROM_STATE:${input.transition.from}->${this.record.state}`);
    }
    if (this.record.state === input.transition.to) return { applied: false, delivery: this.record };
    assertDeliveryTransition(this.record.state, input.transition.to);
    this.record = {
      ...this.record,
      state: input.transition.to,
      attemptCount: this.record.attemptCount + (input.incrementAttempt === true ? 1 : 0),
      ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
      lastReasonCode: input.transition.reasonCode,
      ...(input.transition.reason === undefined ? {} : { lastReason: input.transition.reason }),
      ...(input.transition.to === 'ACCEPTED' ? { acceptedAt: input.transition.occurredAt } : {}),
      updatedAt: input.transition.occurredAt,
    };
    return { applied: true, delivery: this.record };
  }
}

const request: CommunicationProviderSendRequest = {
  tenantId,
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
  idempotencyKey: 'communication-e2e-1',
  requestedAt: '2026-08-25T06:10:00.000Z',
};

test('provider-neutral send acceptance flows through verified delivery webhook exactly once', async () => {
  const repository = new MemoryDeliveryRepository();
  let providerSends = 0;
  const registry = new StaticCommunicationProviderAdapterRegistry([{
    providerKey: connector.providerKey,
    adapter: {
      adapterKey: 'provider-a-runtime',
      supportedChannels: ['email'],
      async send() {
        providerSends += 1;
        return {
          status: 'ACCEPTED' as const,
          reasonCode: 'OK',
          providerMessageId: 'provider-message-1',
          acceptedAt: '2026-08-25T06:10:01.000Z',
        };
      },
    },
  }]);

  const send = await executeCommunicationSendAttempt({
    connector,
    request,
    registry,
    deliveryRepository: repository,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
    attemptedAt: '2026-08-25T06:10:01.000Z',
  });

  assert.equal(send.outcome, 'ACCEPTED');
  assert.equal(repository.record?.state, 'ACCEPTED');
  assert.equal(repository.record?.providerMessageId, 'provider-message-1');
  assert.equal(providerSends, 1);

  const normalizer: CommunicationProviderWebhookNormalizer = {
    adapterKey: 'provider-a-webhook',
    async verifyAndNormalize() {
      return {
        verified: true,
        events: [{
          providerEventId: 'provider-event-delivered-1',
          connectorKey: connector.connectorKey,
          providerMessageId: 'provider-message-1',
          channel: 'email',
          state: 'DELIVERED',
          occurredAt: '2026-08-25T06:10:05.000Z',
        }],
      };
    },
  };

  const webhookInput = {
    tenantId,
    request: { connectorKey: connector.connectorKey, headers: {}, rawBody: new Uint8Array() },
    normalizer,
    deliveryRepository: repository,
  };
  const first = await ingestCommunicationProviderWebhook(webhookInput);
  const duplicate = await ingestCommunicationProviderWebhook(webhookInput);

  assert.deepEqual(first, {
    accepted: true,
    applied: 1,
    duplicateOrNoop: 0,
    unmatched: 0,
    ignoredRegressions: 0,
  });
  assert.equal(repository.record?.state, 'DELIVERED');
  assert.equal(duplicate.accepted && duplicate.duplicateOrNoop, 1);
  assert.equal(providerSends, 1);
});
