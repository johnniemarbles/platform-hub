import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationProviderSendRequest } from '../src/provider-adapter.ts';
import { TwilioSmsWhatsappAdapter } from '../src/twilio-sms-whatsapp-adapter.ts';

const baseRequest: CommunicationProviderSendRequest = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  triggerKey: 'lead.welcome',
  purpose: 'transactional',
  channel: 'sms',
  recipient: { phone: '+1234567890' },
  recipientKey: '+1234567890',
  sender: {
    senderKey: 'sender-1',
    address: '+0987654321',
  },
  rendered: {
    templateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    version: 1,
    channel: 'sms',
    locale: 'en',
    format: 'TEXT',
    body: 'Hello from Twilio',
    variables: {},
  },
  idempotencyKey: 'welcome-1',
  requestedAt: '2026-08-26T18:00:00.000Z',
};

test('sends sms successfully', async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const adapter = new TwilioSmsWhatsappAdapter({
    credentials: async () => ({ accountSid: 'AC123', authToken: 'auth_token' }),
    now: () => '2026-08-26T18:00:01.000Z',
    fetchImpl: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 });
    },
  });

  const result = await adapter.send(baseRequest);
  assert.deepEqual(result, {
    status: 'ACCEPTED',
    reasonCode: 'OK',
    providerMessageId: 'SM123',
    acceptedAt: '2026-08-26T18:00:01.000Z',
  });
  
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: 'Basic QUMxMjM6YXV0aF90b2tlbg==',
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  assert.equal(String(calls[0]?.init?.body), 'To=%2B1234567890&From=%2B0987654321&Body=Hello+from+Twilio');
});

test('sends whatsapp successfully', async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const adapter = new TwilioSmsWhatsappAdapter({
    credentials: async () => ({ accountSid: 'AC123', authToken: 'auth_token' }),
    now: () => '2026-08-26T18:00:01.000Z',
    fetchImpl: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 });
    },
  });

  const whatsappRequest = { ...baseRequest, channel: 'whatsapp' as const };
  const result = await adapter.send(whatsappRequest);
  assert.deepEqual(result, {
    status: 'ACCEPTED',
    reasonCode: 'OK',
    providerMessageId: 'SM123',
    acceptedAt: '2026-08-26T18:00:01.000Z',
  });
  
  assert.equal(String(calls[0]?.init?.body), 'To=whatsapp%3A%2B1234567890&From=whatsapp%3A%2B0987654321&Body=Hello+from+Twilio');
});

test('handles rate limits and auth failures', async () => {
  const statuses = [429, 401, 503];
  const adapter = new TwilioSmsWhatsappAdapter({
    credentials: async () => ({ accountSid: 'AC123', authToken: 'auth_token' }),
    fetchImpl: async () => {
      const status = statuses.shift()!;
      return new Response(null, { status });
    },
  });

  assert.deepEqual(await adapter.send(baseRequest), {
    status: 'RETRYABLE_FAILURE',
    reasonCode: 'RATE_LIMITED',
    reason: 'Provider rate limit reached.',
  });
  assert.deepEqual(await adapter.send(baseRequest), {
    status: 'REJECTED',
    reasonCode: 'AUTHENTICATION_FAILED',
    reason: 'Provider authentication failed.',
  });
  assert.deepEqual(await adapter.send(baseRequest), {
    status: 'RETRYABLE_FAILURE',
    reasonCode: 'PROVIDER_UNAVAILABLE',
    reason: 'Provider is temporarily unavailable.',
  });
});
