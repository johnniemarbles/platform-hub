import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCommunicationAdapterKey } from '../src/governed-action-adapter.ts';
import { inferDefaultCommunicationChannel } from '../src/index.ts';

test('linkedin + social maps to linkedin-social-text-v1', () => {
  assert.equal(
    defaultCommunicationAdapterKey({ providerKey: 'linkedin', channel: 'social' }),
    'linkedin-social-text-v1',
  );
});

test('linkedin is not registered for email', () => {
  assert.equal(
    defaultCommunicationAdapterKey({ providerKey: 'linkedin', channel: 'email' }),
    null,
  );
});

test('subjectId never infers social; social must be explicit', () => {
  assert.equal(inferDefaultCommunicationChannel({ subjectId: 'urn:li:person:abc' }), 'in_app');
});
