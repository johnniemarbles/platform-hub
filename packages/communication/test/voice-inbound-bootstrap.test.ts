import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestCommunicationVoiceWebhook } from '../src/voice-webhook-ingestion.ts';
import type { VoiceTransportRepository } from '../src/voice-transport-repository.ts';
import type { CommunicationProviderVoiceWebhookNormalizer } from '../src/voice-webhook.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const request = { connectorKey: 'voice-primary', headers: {}, rawBody: new Uint8Array() };
const callId = '11111111-1111-1111-1111-111111111111';

function inboundNormalizer(state: 'RINGING' | 'COMPLETED'): CommunicationProviderVoiceWebhookNormalizer {
  return {
    adapterKey: 'voice-webhook',
    async verifyAndNormalize() {
      return {
        verified: true,
        events: [{
          providerEventId: `event-${state}`,
          connectorKey: 'voice-primary',
          providerCallId: 'provider-inbound-1',
          state,
          occurredAt: '2026-08-25T06:00:00.000Z',
          direction: 'INBOUND',
          fromAddress: '+15550000001',
          toAddress: '+15550000002',
        }],
      };
    },
  };
}

test('bootstraps inbound call only through the injected context resolver', async () => {
  let created = 0;
  let transitionFrom: string | undefined;
  const repository: VoiceTransportRepository = {
    async create(input) {
      created += 1;
      assert.equal(input.callId, callId);
      assert.equal(input.organizationId, '22222222-2222-2222-2222-222222222222');
      return {
        callId: input.callId,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        connectorKey: input.connectorKey,
        providerCallId: input.providerCallId,
        direction: input.direction,
        from: input.from,
        to: input.to,
        state: 'REQUESTED',
        requestedAt: input.requestedAt,
      };
    },
    async findByCallId() { return null; },
    async findByProviderCallId() { return null; },
    async applyTransition(input) {
      transitionFrom = input.transition.from;
      return {
        applied: true,
        session: {
          callId,
          tenantId,
          connectorKey: 'voice-primary',
          providerCallId: 'provider-inbound-1',
          direction: 'INBOUND',
          from: { address: '+15550000001' },
          to: { address: '+15550000002' },
          state: input.transition.to,
          requestedAt: '2026-08-25T06:00:00.000Z',
        },
      };
    },
  };

  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer: inboundNormalizer('RINGING'),
    voiceRepository: repository,
    inboundBootstrap: {
      async resolve() {
        return {
          callId,
          organizationId: '22222222-2222-2222-2222-222222222222',
        };
      },
    },
  });

  assert.equal(result.accepted && result.bootstrappedInbound, 1);
  assert.equal(result.accepted && result.applied, 1);
  assert.equal(created, 1);
  assert.equal(transitionFrom, 'REQUESTED');
});

test('does not bootstrap a terminal callback with no existing call session', async () => {
  let resolved = false;
  const repository: VoiceTransportRepository = {
    async create() { throw new Error('should not create'); },
    async findByCallId() { return null; },
    async findByProviderCallId() { return null; },
    async applyTransition() { throw new Error('should not transition'); },
  };

  const result = await ingestCommunicationVoiceWebhook({
    tenantId,
    request,
    normalizer: inboundNormalizer('COMPLETED'),
    voiceRepository: repository,
    inboundBootstrap: {
      async resolve() { resolved = true; return { callId }; },
    },
  });

  assert.equal(result.accepted && result.unmatched, 1);
  assert.equal(result.accepted && result.bootstrappedInbound, 0);
  assert.equal(resolved, false);
});
