import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationProviderSendRequest } from '../src/provider-adapter.ts';
import { ResendEmailAdapter } from '../src/resend-email-adapter.ts';

const baseRequest: CommunicationProviderSendRequest = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  triggerKey: 'lead.welcome',
  purpose: 'transactional',
  channel: 'email',
  recipient: { email: 'person@example.test' },
  recipientKey: 'person@example.test',
  sender: {
    senderKey: 'sender-1',
    address: 'hello@example.test',
    displayName: 'EXPADIO',
    replyTo: 'support@example.test',
  },
  rendered: {
    templateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    version: 1,
    channel: 'email',
    locale: 'en',
    format: 'HTML',
    subject: 'Welcome',
    body: '<p>Hello</p>',
    variables: {},
  },
  idempotencyKey: 'welcome-1',
  requestedAt: '2026-08-26T18:00:00.000Z',
};

test('sends a provider-neutral HTML request through the Resend HTTP boundary', async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const adapter = new ResendEmailAdapter({
    apiToken: async () => 're_test_token',
    now: () => '2026-08-26T18:00:01.000Z',
    fetchImpl: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Response.json({ id: 'resend-message-1' });
    },
  });

  const result = await adapter.send(baseRequest);

  assert.deepEqual(result, {
    status: 'ACCEPTED',
    reasonCode: 'OK',
    providerMessageId: 'resend-message-1',
    acceptedAt: '2026-08-26T18:00:01.000Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), 'https://api.resend.com/emails');
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: 'Bearer re_test_token',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'welcome-1',
  });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    from: 'EXPADIO <hello@example.test>',
    to: ['person@example.test'],
    subject: 'Welcome',
    reply_to: 'support@example.test',
    html: '<p>Hello</p>',
  });
});

test('uses plain text for TEXT and MARKDOWN templates', async () => {
  const bodies: unknown[] = [];
  const adapter = new ResendEmailAdapter({
    apiToken: async () => 're_test_token',
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'message-2' });
    },
  });

  await adapter.send({
    ...baseRequest,
    rendered: { ...baseRequest.rendered, format: 'TEXT', body: 'Hello' },
  });
  await adapter.send({
    ...baseRequest,
    idempotencyKey: 'welcome-2',
    rendered: { ...baseRequest.rendered, format: 'MARKDOWN', body: '**Hello**' },
  });

  assert.deepEqual(bodies.map((body) => body as Record<string, unknown>), [
    { from: 'EXPADIO <hello@example.test>', to: ['person@example.test'], subject: 'Welcome', reply_to: 'support@example.test', text: 'Hello' },
    { from: 'EXPADIO <hello@example.test>', to: ['person@example.test'], subject: 'Welcome', reply_to: 'support@example.test', text: '**Hello**' },
  ]);
});

test('fails closed before credential access when recipient or sender is invalid', async () => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  const adapter = new ResendEmailAdapter({
    apiToken: async () => { credentialCalls += 1; return 're_test_token'; },
    fetchImpl: async () => { fetchCalls += 1; return Response.json({ id: 'unexpected' }); },
  });

  const recipient = await adapter.send({ ...baseRequest, recipient: {} });
  const sender = await adapter.send({ ...baseRequest, sender: undefined });

  assert.equal(recipient.reasonCode, 'INVALID_RECIPIENT');
  assert.equal(sender.reasonCode, 'SENDER_REJECTED');
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('classifies rate limits, authentication failures, and provider outages', async () => {
  const statuses = [429, 401, 503];
  const adapter = new ResendEmailAdapter({
    apiToken: async () => 're_test_token',
    fetchImpl: async () => {
      const status = statuses.shift()!;
      return new Response(null, {
        status,
        ...(status === 429 ? { headers: { 'retry-after': '2.5' } } : {}),
      });
    },
  });

  assert.deepEqual(await adapter.send(baseRequest), {
    status: 'RETRYABLE_FAILURE',
    reasonCode: 'RATE_LIMITED',
    retryAfterMs: 2500,
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

test('does not convert network exceptions before the send-attempt retry layer', async () => {
  const adapter = new ResendEmailAdapter({
    apiToken: async () => 're_test_token',
    fetchImpl: async () => { throw new Error('network unavailable'); },
  });
  await assert.rejects(() => adapter.send(baseRequest), /network unavailable/);
});
