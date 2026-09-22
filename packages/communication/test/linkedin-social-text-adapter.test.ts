import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationProviderSendRequest } from '../src/provider-adapter.ts';
import { LinkedInSocialTextAdapter, personUrn } from '../src/linkedin-social-text-adapter.ts';

function request(
  overrides: Partial<CommunicationProviderSendRequest> = {},
): CommunicationProviderSendRequest {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    triggerKey: 'social.content_publish',
    purpose: 'marketing',
    channel: 'social',
    recipient: { subjectId: 'abc123' },
    recipientKey: 'abc123',
    rendered: { format: 'TEXT', body: 'Hello network' },
    idempotencyKey: 'idem-1',
    requestedAt: '2026-08-31T06:00:00.000Z',
    ...overrides,
  };
}

function adapter(fetchImpl: typeof fetch) {
  return new LinkedInSocialTextAdapter({
    accessToken: async () => 'leased-token',
    fetchImpl,
    now: () => '2026-08-31T06:00:01.000Z',
  });
}

test('personUrn normalizes raw ids and rejects junk', () => {
  assert.equal(personUrn('abc123'), 'urn:li:person:abc123');
  assert.equal(personUrn('urn:li:person:abc123'), 'urn:li:person:abc123');
  assert.equal(personUrn(''), null);
  assert.equal(personUrn('urn:li:organization:1'), null);
  assert.equal(personUrn('abc 123'), null);
});

test('adapter key and channel match registration contract', () => {
  const a = adapter(async () => new Response('', { status: 500 }));
  assert.equal(a.adapterKey, 'linkedin-social-text-v1');
  assert.deepEqual([...a.supportedChannels], ['social']);
});

test('wrong channel is rejected without calling LinkedIn', async () => {
  let called = 0;
  const a = adapter(async () => {
    called += 1;
    return new Response('', { status: 201 });
  });
  const result = await a.send(request({ channel: 'email' }));
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reasonCode, 'PROVIDER_REJECTED');
  assert.equal(called, 0);
});

test('missing subjectId is INVALID_RECIPIENT', async () => {
  const a = adapter(async () => new Response('', { status: 201 }));
  const result = await a.send(request({ recipient: {}, recipientKey: 'none' }));
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reasonCode, 'INVALID_RECIPIENT');
});

test('201 with x-restli-id is ACCEPTED with providerMessageId', async () => {
  const a = adapter(async (url, init) => {
    assert.equal(String(url), 'https://api.linkedin.com/v2/ugcPosts');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer leased-token');
    const payload = JSON.parse(String(init?.body)) as { author: string };
    assert.equal(payload.author, 'urn:li:person:abc123');
    return new Response('{}', {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:99' },
    });
  });
  const result = await a.send(request());
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.providerMessageId, 'urn:li:share:99');
});

test('synthetic restli id is not ACCEPTED', async () => {
  const a = adapter(async () =>
    new Response('{}', {
      status: 201,
      headers: { 'x-restli-id': 'linkedin-unreconciled-1' },
    }),
  );
  const result = await a.send(request());
  assert.equal(result.status, 'RETRYABLE_FAILURE');
  assert.equal(result.providerMessageId, undefined);
});
