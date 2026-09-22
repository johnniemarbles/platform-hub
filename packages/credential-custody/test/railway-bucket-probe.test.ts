import assert from 'node:assert/strict';
import test from 'node:test';
import { railwayBucketProbe, probeFor } from '../src/probe.ts';

test('Railway bucket probe signs a read-only ListObjectsV2 and advertises storage capabilities', async () => {
  let request: { url: string; method?: string; authorization?: string } | null = null;
  const result = await railwayBucketProbe.probe({
    providerKey: 'railway-bucket',
    secret: 'test-secret-access-key',
    parameters: {
      accessKeyId: 'test-access-key-id',
      endpoint: 'https://t3.storageapi.dev',
      bucket: 'expadio-artifacts-abc123',
      region: 'auto',
    },
    now: () => '2026-09-19T00:00:00.000Z',
    fetchImpl: (async (input, init) => {
      request = {
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('Authorization') ?? undefined,
      };
      return new Response('<ListBucketResult></ListBucketResult>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    }) as typeof fetch,
  });

  assert.ok(request !== null);
  const observed = request as { url: string; method?: string; authorization?: string };
  assert.equal(observed.url, 'https://expadio-artifacts-abc123.t3.storageapi.dev/?list-type=2&max-keys=1');
  assert.equal(observed.method, 'GET');
  assert.ok(observed.authorization?.startsWith('AWS4-HMAC-SHA256'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.detectedCapabilities, ['storage.store', 'storage.read']);
  assert.equal(probeFor('railway-bucket'), railwayBucketProbe);
});

test('Railway bucket probe rejects when the bucket returns an auth failure', async () => {
  const result = await railwayBucketProbe.probe({
    providerKey: 'railway-bucket',
    secret: 'wrong-secret',
    parameters: {
      accessKeyId: 'test-access-key-id',
      endpoint: 'https://t3.storageapi.dev',
      bucket: 'expadio-artifacts-abc123',
    },
    fetchImpl: (async () => new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', {
      status: 403,
      headers: { 'Content-Type': 'application/xml' },
    })) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /HTTP 403/);
});

test('Railway bucket probe requires access key ID, endpoint, and bucket', async () => {
  const result = await railwayBucketProbe.probe({
    providerKey: 'railway-bucket',
    secret: 'test-secret-access-key',
    parameters: {},
    fetchImpl: (async () => { throw new Error('should not be called'); }) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Access key ID, endpoint, and bucket are required.');
});

test('Railway bucket probe rejects a malformed endpoint before signing anything', async () => {
  const result = await railwayBucketProbe.probe({
    providerKey: 'railway-bucket',
    secret: 'test-secret-access-key',
    parameters: { accessKeyId: 'id', endpoint: 'not-a-url', bucket: 'my-bucket' },
    fetchImpl: (async () => { throw new Error('should not be called'); }) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Endpoint is not a valid URL.');
});
