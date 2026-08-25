import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommunicationIntentIdentityError,
  communicationRecipientKey,
  inferDefaultCommunicationChannel,
  resolveCommunicationIntentIdentity,
  type CommunicationIntent,
} from '../src/index.ts';

function intent(overrides: Partial<CommunicationIntent> = {}): CommunicationIntent {
  return {
    triggerKey: 'lead.followup',
    tenantId: 'tenant-a',
    recipient: { email: ' Person@Example.COM ' },
    variables: {},
    idempotencyKey: ' message-1 ',
    purpose: 'transactional',
    consentRequired: false,
    ...overrides,
  };
}

test('intent identity requires trigger, tenant and idempotency key', () => {
  assert.throws(
    () => resolveCommunicationIntentIdentity(intent({ idempotencyKey: '   ' })),
    (error: unknown) =>
      error instanceof CommunicationIntentIdentityError && error.code === 'IDEMPOTENCY_REQUIRED',
  );
});

test('default channel inference is deterministic and conservative', () => {
  assert.equal(
    inferDefaultCommunicationChannel({ email: 'a@example.com', whatsapp: '+1', phone: '+2' }),
    'email',
  );
  assert.equal(inferDefaultCommunicationChannel({ whatsapp: '+1', phone: '+2' }), 'whatsapp');
  assert.equal(inferDefaultCommunicationChannel({ phone: '+2' }), 'sms');
  assert.equal(inferDefaultCommunicationChannel({ subjectId: 'subject-1' }), 'in_app');
});

test('resolved identity normalizes email recipient key and idempotency key', () => {
  assert.deepEqual(resolveCommunicationIntentIdentity(intent()), {
    channel: 'email',
    recipientKey: 'person@example.com',
    idempotencyKey: 'message-1',
  });
});

test('voice and push must be selected explicitly rather than inferred', () => {
  assert.equal(inferDefaultCommunicationChannel({ phone: '+14165551234' }), 'sms');
  assert.equal(inferDefaultCommunicationChannel({ subjectId: 'subject-1' }), 'in_app');
  assert.equal(communicationRecipientKey({ phone: ' +14165551234 ' }, 'voice'), '+14165551234');
  assert.equal(communicationRecipientKey({ subjectId: 'subject-1' }, 'push'), 'subject-1');
});
