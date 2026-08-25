import assert from 'node:assert/strict';
import test from 'node:test';
import {
  communicationChannelMetadata,
  listCommunicationChannels,
  recipientSupportsChannel,
} from '../src/index.ts';

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
