import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestCommunicationVoiceWebhook } from '../src/voice-webhook-ingestion.ts';
import type { VoiceTransportRepository } from '../src/voice-transport-repository.ts';
import type { CommunicationProviderVoiceWebhookNormalizer } from '../src/voice-webhook.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const request = { connectorKey: 'voice-primary', headers: {}, rawBody: new Uint8Array() };
const session = {
  callId: '11111111-1111-1111-1111-111111111111',
  tenantId,
  connectorKey: 'voice-primary',
  providerCallId: 'provider-call-1',
  direction: 'OUTBOUND' as const,
  from: { address: '+15550000001' },
  to: { address: '+15550000002' },
  state: 'RINGING' as const,
  requestedAt: '2026-08-25T05:00:00.000Z',
};

function repository(overrides: Partial<VoiceTransportRepository> = {}): VoiceTransportRepository {
  return {
    async create() { return session; },
    async findByCallId() { return session; },
    async findByProviderCallId() { return session; },
    async applyTransition(input) {
      return { applied: true, session: { ...session, state: input.transition.to } };
    },
    ...overrides,
  };
}

const normalizer: CommunicationProviderVoiceWebhookNormalizer = {
  adapterKey: 'voice-webhook',
  async verifyAndNormalize() {
    return {
      verified: true,
      events: [{
        providerEventId: 'voice-event-1',
        connectorKey: 'voice-primary',
        providerCallId: 'provider-call-1',
        state: 'ANSWERED',
        occurredAt: '2026-08-25T05:01:00.000Z',
      }],
    };
  },
};

test('rejects unverified voice webhook before repository lookup', async () => {
  let lookedUp = false;
  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer: {
      adapterKey: 'bad',
      async verifyAndNormalize() {
        return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID' };
      },
    },
    voiceRepository: repository({
      async findByProviderCallId() { lookedUp = true; return session; },
    }),
  });

  assert.equal(result.accepted, false);
  assert.equal(lookedUp, false);
});

test('applies verified voice lifecycle event using current persisted state', async () => {
  let receivedFrom: string | undefined;
  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer,
    voiceRepository: repository({
      async applyTransition(input) {
        receivedFrom = input.transition.from;
        return { applied: true, session: { ...session, state: input.transition.to } };
      },
    }),
  });

  assert.equal(result.accepted, true);
  assert.equal(result.accepted && result.applied, 1);
  assert.equal(receivedFrom, 'RINGING');
});

test('counts unknown provider call ids without creating hidden sessions', async () => {
  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer,
    voiceRepository: repository({ async findByProviderCallId() { return null; } }),
  });

  assert.equal(result.accepted && result.unmatched, 1);
});

test('counts deduplicated no-op callbacks', async () => {
  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer,
    voiceRepository: repository({
      async applyTransition() { return { applied: false, session }; },
    }),
  });

  assert.equal(result.accepted && result.duplicateOrNoop, 1);
});

test('ignores stale/regressive callbacks but propagates unrelated repository failures', async () => {
  const regression = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer,
    voiceRepository: repository({
      async applyTransition() { throw new Error('VOICE_CALL_TRANSITION_INVALID:COMPLETED->ANSWERED'); },
    }),
  });
  assert.equal(regression.accepted && regression.ignoredRegressions, 1);

  await assert.rejects(
    () => ingestCommunicationVoiceWebhook({
      tenantId,
      request,
      normalizer,
      voiceRepository: repository({ async applyTransition() { throw new Error('database down'); } }),
    }),
    /database down/,
  );
});
