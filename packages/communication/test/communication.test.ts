import assert from 'node:assert/strict';
import test from 'node:test';
import {
  communicationChannelMetadata,
  evaluateCommunicationPreflight,
  listCommunicationChannels,
  recipientSupportsChannel,
} from '../src/index.ts';

const baseIntent = {
  triggerKey: 'lead.followup',
  tenantId: 'tenant-a',
  recipient: { phone: '+14165551234' },
  variables: {},
  idempotencyKey: 'idem-1',
  purpose: 'transactional' as const,
  consentRequired: false,
};

test('communication channel registry preserves consent and suppression semantics', () => {
  assert.equal(communicationChannelMetadata('voice').requiresConsent, true);
  assert.equal(communicationChannelMetadata('voice').supportsSuppression, true);
  assert.equal(communicationChannelMetadata('email').supportsSuppression, true);
  assert.equal(communicationChannelMetadata('in_app').supportsSuppression, false);
  assert.equal(listCommunicationChannels().length, 7);
});

test('recipient capability is channel-specific', () => {
  const recipient = {
    subjectId: 'subject-1',
    email: 'person@example.com',
    phone: '+14165551234',
  };

  assert.equal(recipientSupportsChannel(recipient, 'email'), true);
  assert.equal(recipientSupportsChannel(recipient, 'sms'), true);
  assert.equal(recipientSupportsChannel(recipient, 'voice'), true);
  assert.equal(recipientSupportsChannel(recipient, 'whatsapp'), true);
  assert.equal(recipientSupportsChannel(recipient, 'in_app'), true);
  assert.equal(recipientSupportsChannel(recipient, 'push'), true);
  assert.equal(recipientSupportsChannel(recipient, 'rcs'), true);
});

test('recipient capability fails closed when required addressing is absent', () => {
  const recipient = { email: 'person@example.com' };

  assert.equal(recipientSupportsChannel(recipient, 'email'), true);
  assert.equal(recipientSupportsChannel(recipient, 'voice'), false);
  assert.equal(recipientSupportsChannel(recipient, 'in_app'), false);
  assert.equal(recipientSupportsChannel(recipient, 'push'), false);
});

test('preflight rejects a channel without a usable recipient address', () => {
  const decision = evaluateCommunicationPreflight({
    intent: { ...baseIntent, recipient: { email: 'person@example.com' } },
    channel: 'voice',
    consentGranted: true,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'INVALID_RECIPIENT');
});

test('preflight requires consent when channel or intent requires it', () => {
  const decision = evaluateCommunicationPreflight({
    intent: baseIntent,
    channel: 'voice',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'CONSENT_MISSING');
});

test('preflight applies suppression before provider routing', () => {
  const decision = evaluateCommunicationPreflight({
    intent: baseIntent,
    channel: 'voice',
    consentGranted: true,
    suppression: { reason: 'OPT_OUT' },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'SUPPRESSED');
});

test('preflight allows an addressable, consented, non-suppressed intent', () => {
  const decision = evaluateCommunicationPreflight({
    intent: baseIntent,
    channel: 'voice',
    consentGranted: true,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reasonCode, 'OK');
});
