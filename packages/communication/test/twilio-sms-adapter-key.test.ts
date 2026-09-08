import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCommunicationAdapterKey } from '../src/governed-action-adapter.ts';

test('catalog provider keys map to executable Twilio adapters', () => {
  assert.equal(
    defaultCommunicationAdapterKey({ providerKey: 'twilio-sms', channel: 'sms' }),
    'twilio-sms-whatsapp-v1',
  );
  assert.equal(
    defaultCommunicationAdapterKey({ providerKey: 'twilio-whatsapp', channel: 'whatsapp' }),
    'twilio-sms-whatsapp-v1',
  );
  assert.equal(
    defaultCommunicationAdapterKey({ providerKey: 'twilio-voice', channel: 'voice' }),
    'twilio-voice-v1',
  );
});
