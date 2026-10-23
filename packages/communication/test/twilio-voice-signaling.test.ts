import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTwilioVoiceSignalingUrl,
  resolveTwilioVoiceStatusCallbackUrl,
} from '../src/twilio-voice-signaling.ts';

test('keeps an explicit https TwiML body', () => {
  const url = resolveTwilioVoiceSignalingUrl({
    renderedBody: 'https://platform.example/api/voice/twilio/inbound?tenantId=t',
    tenantId: 't',
  });
  assert.equal(url, 'https://platform.example/api/voice/twilio/inbound?tenantId=t');
});

test('builds inbound URL from base when body is spoken text', () => {
  const url = resolveTwilioVoiceSignalingUrl({
    renderedBody: 'Please call the customer',
    tenantId: 'tenant-1',
    connectorKey: 'twilio-voice',
    baseUrl: 'https://platform.example',
  });
  assert.equal(
    url,
    'https://platform.example/api/voice/twilio/inbound?tenantId=tenant-1&connectorKey=twilio-voice',
  );
});

test('builds signed communications webhook as status callback', () => {
  const url = resolveTwilioVoiceStatusCallbackUrl({
    tenantId: 'tenant-1',
    connectorKey: 'twilio-voice',
    baseUrl: 'https://platform.example',
  });
  assert.equal(
    url,
    'https://platform.example/api/webhooks/twilio?tenantId=tenant-1&connectorKey=twilio-voice',
  );
});
