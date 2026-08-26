import { test } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { TwilioWebhookNormalizer } from '../src/twilio-webhook-normalizer.ts';

test('TwilioWebhookNormalizer - verifyAndNormalize', async (t) => {
  await t.test('accepts valid twilio signature for SMS', async () => {
    const normalizer = new TwilioWebhookNormalizer({
      adapterKey: 'twilio-sms-whatsapp-v1',
      resolveAuthToken: async () => 'my-auth-token',
      getWebhookUrl: () => 'https://my.webhook.url/api/twilio',
    });

    const params = new URLSearchParams();
    params.set('MessageSid', 'SM123');
    params.set('MessageStatus', 'sent');
    params.set('AccountSid', 'AC123');

    const rawBody = new TextEncoder().encode(params.toString());
    const expectedSig = createHmac('sha1', 'my-auth-token')
      .update('https://my.webhook.url/api/twilioAccountSidAC123MessageSidSM123MessageStatussent')
      .digest('base64');

    const result = await normalizer.verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: {
        'x-twilio-signature': expectedSig,
      },
      rawBody
    });

    assert.strictEqual(result.verified, true);
    if (result.verified) {
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].state, 'SENT');
      assert.strictEqual(result.events[0].providerMessageId, 'SM123');
      assert.strictEqual(result.events[0].channel, 'SMS');
    }
  });

  await t.test('accepts valid twilio signature for Voice', async () => {
    const normalizer = new TwilioWebhookNormalizer({
      adapterKey: 'twilio-voice-v1',
      resolveAuthToken: async () => 'my-auth-token',
      getWebhookUrl: () => 'https://my.webhook.url/api/twilio',
    });

    const params = new URLSearchParams();
    params.set('CallSid', 'CA123');
    params.set('CallStatus', 'completed');

    const rawBody = new TextEncoder().encode(params.toString());
    const expectedSig = createHmac('sha1', 'my-auth-token')
      .update('https://my.webhook.url/api/twilioCallSidCA123CallStatuscompleted')
      .digest('base64');

    const result = await normalizer.verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: {
        'x-twilio-signature': expectedSig,
      },
      rawBody
    });

    assert.strictEqual(result.verified, true);
    if (result.verified) {
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].state, 'DELIVERED');
      assert.strictEqual(result.events[0].providerMessageId, 'CA123');
      assert.strictEqual(result.events[0].channel, 'VOICE');
    }
  });

  await t.test('rejects invalid twilio signature', async () => {
    const normalizer = new TwilioWebhookNormalizer({
      adapterKey: 'twilio-sms-whatsapp-v1',
      resolveAuthToken: async () => 'my-auth-token',
      getWebhookUrl: () => 'https://my.webhook.url/api/twilio',
    });

    const result = await normalizer.verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: {
        'x-twilio-signature': 'invalid_sig',
      },
      rawBody: new TextEncoder().encode('foo=bar')
    });

    assert.strictEqual(result.verified, false);
    if (!result.verified) {
      assert.strictEqual(result.reasonCode, 'WEBHOOK_SIGNATURE_INVALID');
    }
  });
});
