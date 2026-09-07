import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudflareProbe, probeFor } from '../src/probe.ts';

test('Cloudflare token probe is read-only and exposes DNS capability', async () => {
  let request: { url: string; method?: string; authorization?: string } | null = null;
  const result = await cloudflareProbe.probe({
    providerKey: 'cloudflare',
    secret: 'test-token',
    parameters: {},
    now: () => '2026-09-07T00:00:00.000Z',
    fetchImpl: (async (input, init) => {
      request = {
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('Authorization') ?? undefined,
      };
      return new Response(JSON.stringify({ success: true, result: { status: 'active' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.ok(request !== null);
  const observed = request as { url: string; method?: string; authorization?: string };
  assert.equal(observed.url, 'https://api.cloudflare.com/client/v4/user/tokens/verify');
  assert.equal(observed.method, 'GET');
  assert.equal(observed.authorization, 'Bearer test-token');
  assert.equal(result.valid, true);
  assert.deepEqual(result.detectedCapabilities, ['infrastructure.dns.configure']);
  assert.equal(probeFor('cloudflare'), cloudflareProbe);
});

test('Cloudflare token probe rejects inactive tokens', async () => {
  const result = await cloudflareProbe.probe({
    providerKey: 'cloudflare',
    secret: 'inactive-token',
    parameters: {},
    fetchImpl: (async () => new Response(
      JSON.stringify({ success: true, result: { status: 'disabled' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.detectedCapabilities, []);
});
