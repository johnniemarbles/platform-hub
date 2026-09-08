import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCommunicationPreflight } from '../src/index.ts';

test('system-purpose SMS certification does not require recipient consent', () => {
  const decision = evaluateCommunicationPreflight({
    channel: 'sms',
    intent: {
      triggerKey: 'communications.live-certification',
      tenantId: '00000000-0000-0000-0000-000000000001',
      recipient: { phone: '+16476190871' },
      variables: {},
      idempotencyKey: 'cert-sms',
      purpose: 'system',
      consentRequired: false,
      channel: 'sms',
    },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reasonCode, 'OK');
});

test('marketing SMS still requires consent', () => {
  const decision = evaluateCommunicationPreflight({
    channel: 'sms',
    intent: {
      triggerKey: 'brand.lead.direct',
      tenantId: '00000000-0000-0000-0000-000000000001',
      recipient: { phone: '+16476190871' },
      variables: {},
      idempotencyKey: 'lead-sms',
      purpose: 'marketing',
      consentRequired: true,
      channel: 'sms',
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'CONSENT_MISSING');
});
