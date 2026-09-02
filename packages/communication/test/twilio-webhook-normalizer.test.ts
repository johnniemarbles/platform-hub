import { test } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { TwilioWebhookNormalizer } from '../src/twilio-webhook-normalizer.ts';

const webhookUrl = 'https://my.webhook.url/api/twilio';
const authToken = 'my-auth-token';
const now = '2026-09-02T16:30:00.000Z';

function signature(params: URLSearchParams): string {
  let input = webhookUrl;
  for (const key of [...new Set(params.keys())].sort()) input += key + params.get(key);
  return createHmac('sha1', authToken).update(input).digest('base64');
}

function normalizer(adapterKey: 'twilio-sms-whatsapp-v1' | 'twilio-voice-v1') {
  return new TwilioWebhookNormalizer({
    adapterKey,
    resolveAuthToken: async () => authToken,
    getWebhookUrl: () => webhookUrl,
    now: () => now,
  });
}

test('TwilioWebhookNormalizer - verifyAndNormalize', async (t) => {
  await t.test('accepts SMS and produces a deterministic lifecycle event id', async () => {
    const params = new URLSearchParams();
    params.set('MessageSid', 'SM123');
    params.set('MessageStatus', 'sent');
    params.set('AccountSid', 'AC123');

    const result = await normalizer('twilio-sms-whatsapp-v1').verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: { 'x-twilio-signature': signature(params) },
      rawBody: new TextEncoder().encode(params.toString()),
    });

    assert.strictEqual(result.verified, true);
    if (result.verified) {
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].state, 'SENT');
      assert.strictEqual(result.events[0].providerMessageId, 'SM123');
      assert.strictEqual(result.events[0].providerEventId, 'SM123:sent');
      assert.strictEqual(result.events[0].channel, 'sms');
      assert.strictEqual(result.events[0].occurredAt, now);
    }
  });

  await t.test('distinguishes WhatsApp callbacks from SMS and permits later delivered evidence', async () => {
    const sent = new URLSearchParams();
    sent.set('MessageSid', 'SM-WA-123');
    sent.set('MessageStatus', 'sent');
    sent.set('To', 'whatsapp:+15551239992');
    sent.set('From', 'whatsapp:+15551230002');

    const delivered = new URLSearchParams(sent);
    delivered.set('MessageStatus', 'delivered');

    const first = await normalizer('twilio-sms-whatsapp-v1').verifyAndNormalize({
      connectorKey: 'whatsapp-connector',
      headers: { 'x-twilio-signature': signature(sent) },
      rawBody: new TextEncoder().encode(sent.toString()),
    });
    const second = await normalizer('twilio-sms-whatsapp-v1').verifyAndNormalize({
      connectorKey: 'whatsapp-connector',
      headers: { 'x-twilio-signature': signature(delivered) },
      rawBody: new TextEncoder().encode(delivered.toString()),
    });

    assert.strictEqual(first.verified, true);
    assert.strictEqual(second.verified, true);
    if (first.verified && second.verified) {
      assert.strictEqual(first.events[0].channel, 'whatsapp');
      assert.strictEqual(second.events[0].channel, 'whatsapp');
      assert.strictEqual(first.events[0].providerEventId, 'SM-WA-123:sent');
      assert.strictEqual(second.events[0].providerEventId, 'SM-WA-123:delivered');
      assert.notStrictEqual(first.events[0].providerEventId, second.events[0].providerEventId);
    }
  });

  await t.test('accepts valid Twilio signature for Voice', async () => {
    const params = new URLSearchParams();
    params.set('CallSid', 'CA123');
    params.set('CallStatus', 'completed');

    const result = await normalizer('twilio-voice-v1').verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: { 'x-twilio-signature': signature(params) },
      rawBody: new TextEncoder().encode(params.toString()),
    });

    assert.strictEqual(result.verified, true);
    if (result.verified) {
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].state, 'DELIVERED');
      assert.strictEqual(result.events[0].providerMessageId, 'CA123');
      assert.strictEqual(result.events[0].providerEventId, 'CA123:completed');
      assert.strictEqual(result.events[0].channel, 'voice');
    }
  });

  await t.test('rejects invalid Twilio signature', async () => {
    const result = await normalizer('twilio-sms-whatsapp-v1').verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: { 'x-twilio-signature': 'invalid_sig' },
      rawBody: new TextEncoder().encode('foo=bar'),
    });

    assert.strictEqual(result.verified, false);
    if (!result.verified) assert.strictEqual(result.reasonCode, 'WEBHOOK_SIGNATURE_INVALID');
  });
});