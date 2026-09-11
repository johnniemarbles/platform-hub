import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RailwayContentAssetStore,
  parseRailwayBucketReference,
} from '../src/railway-content-asset-store.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const REFERENCE = `content-assets/${TENANT}/${ORGANIZATION}/${ASSET}`;
const KEY = `tenants/${TENANT}/organizations/${ORGANIZATION}/content-assets/${ASSET}`;
const BUCKET = 'expadio-content-assets-jdhhd8oe18xi';
const NOW = new Date('2026-09-11T12:00:00Z');

const BYTES = new TextEncoder().encode('an image, notionally');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

function store(
  respond: (call: Call) => Response,
  calls: Call[] = [],
  options: { signedReadTtlSeconds?: number } = {},
): RailwayContentAssetStore {
  return new RailwayContentAssetStore({
    endpoint: 'https://t3.storageapi.dev',
    bucket: BUCKET,
    region: 'auto',
    credentials: async () => ({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    }),
    residencyTags: ['eu', 'us'],
    complianceTags: ['gdpr'],
    ...options,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
      };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
    now: () => NOW,
  });
}

function write(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    assetId: ASSET,
    objectReference: REFERENCE,
    content: BYTES,
    contentType: 'image/jpeg',
    expectedByteLength: BYTES.byteLength,
    expectedSha256: SHA256,
    requiredResidencyTags: ['eu'],
    requiredComplianceTags: ['gdpr'],
    correlationId: 'corr-1',
    ...overrides,
  } as Parameters<RailwayContentAssetStore['store']>[0];
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    assetId: ASSET,
    objectReference: REFERENCE,
    purpose: 'social.publish',
    requiredResidencyTags: ['eu'],
    requiredComplianceTags: ['gdpr'],
    ...overrides,
  } as Parameters<RailwayContentAssetStore['issueReadGrant']>[0];
}

const ABSENT = () => new Response(null, { status: 404 });

test('stores bytes at the tenant-scoped key and signs the request', async () => {
  const calls: Call[] = [];
  const result = await store(
    (call) => (call.method === 'HEAD' ? ABSENT() : new Response(null, { status: 200 })),
    calls,
  ).store(write());

  assert.equal(result.providerReference, `railway-bucket://${BUCKET}/${KEY}`);
  assert.equal(result.sha256, SHA256);
  assert.equal(result.byteLength, BYTES.byteLength);

  const put = calls.find((call) => call.method === 'PUT');
  assert.ok(put, 'expected a PUT');
  // Virtual-hosted style: the bucket is the subdomain, not the first path segment.
  assert.equal(put.url, `https://${BUCKET}.t3.storageapi.dev/${KEY}`);
  assert.match(put.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260911\/auto\/s3\/aws4_request, /u);
  assert.equal(put.headers['x-amz-content-sha256'], SHA256);
  assert.equal(put.headers['if-none-match'], '*');
  assert.equal(put.headers['x-amz-meta-content-sha256'], SHA256);
  assert.equal(put.headers['content-type'], 'image/jpeg');
});

test('a replay of the same bytes succeeds without writing again', async () => {
  const calls: Call[] = [];
  const result = await store(
    () => new Response(null, {
      status: 200,
      headers: { 'x-amz-meta-content-sha256': SHA256 },
    }),
    calls,
  ).store(write());

  assert.equal(result.sha256, SHA256);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD']);
});

/**
 * The invariant this protects: a content asset is immutable once stored. A
 * second upload under the same asset id carrying different bytes is not an
 * update, it is a swap — and the digest downstream has already been recorded.
 */
test('a replay carrying different bytes is refused', async () => {
  const other = createHash('sha256').update('different').digest('hex');
  await assert.rejects(
    store(() => new Response(null, {
      status: 200,
      headers: { 'x-amz-meta-content-sha256': other },
    })).store(write()),
    /CONTENT_ASSET_IMMUTABLE_REPLAY_CONFLICT/u,
  );
});

test('a write that loses the race is resolved by the digest, not by overwriting', async () => {
  let headSeen = 0;
  const result = await store((call) => {
    if (call.method === 'HEAD') {
      headSeen += 1;
      return headSeen === 1
        ? ABSENT()
        : new Response(null, { status: 200, headers: { 'x-amz-meta-content-sha256': SHA256 } });
    }
    return new Response(null, { status: 412 });
  }).store(write());
  assert.equal(result.sha256, SHA256);
  assert.equal(headSeen, 2);
});

test('an object stored with no recorded digest is never overwritten', async () => {
  await assert.rejects(
    store(() => new Response(null, { status: 200 })).store(write()),
    /CONTENT_ASSET_STORED_DIGEST_UNREADABLE/u,
  );
});

test('a read grant is a presigned GET that expires when it says it does', async () => {
  const result = await store(ABSENT).issueReadGrant(grant());
  const url = new URL(result.url);

  assert.equal(url.origin, `https://${BUCKET}.t3.storageapi.dev`);
  assert.equal(url.pathname, `/${KEY}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(result.expiresAt, '2026-09-11T12:05:00.000Z');
  assert.equal(result.objectReference, REFERENCE);
});

test('a read grant never leaves the bucket credentials in the URL', async () => {
  const { url } = await store(ABSENT).issueReadGrant(grant());
  assert.ok(!url.includes('wJalrXUtnFEMI'), 'the secret key must not appear in a grant');
});

test('refuses a reference that is scoped to a different tenant', async () => {
  await assert.rejects(
    store(ABSENT).store(write({
      objectReference: `content-assets/${ORGANIZATION}/${ORGANIZATION}/${ASSET}`,
    })),
    /CONTENT_ASSET_REFERENCE_SCOPE_MISMATCH/u,
  );
});

test('refuses bytes that do not match what was declared', async () => {
  await assert.rejects(
    store(ABSENT).store(write({ expectedSha256: 'f'.repeat(64) })),
    /CONTENT_ASSET_DIGEST_MISMATCH/u,
  );
  await assert.rejects(
    store(ABSENT).store(write({ expectedByteLength: 1 })),
    /CONTENT_ASSET_BYTE_LENGTH_MISMATCH/u,
  );
});

test('refuses a residency or compliance requirement the bucket cannot satisfy', async () => {
  await assert.rejects(
    store(ABSENT).store(write({ requiredResidencyTags: ['ap'] })),
    /CONTENT_ASSET_RESIDENCY_REQUIREMENT_UNSATISFIED/u,
  );
  await assert.rejects(
    store(ABSENT).issueReadGrant(grant({ requiredComplianceTags: ['hipaa'] })),
    /CONTENT_ASSET_COMPLIANCE_REQUIREMENT_UNSATISFIED/u,
  );
});

test('refuses configuration that would point the store somewhere else', () => {
  const base = {
    bucket: BUCKET,
    region: 'auto',
    credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
    residencyTags: [],
    complianceTags: [],
  };
  assert.throws(
    () => new RailwayContentAssetStore({ ...base, endpoint: 'http://t3.storageapi.dev' }),
    /CONTENT_ASSET_ENDPOINT_HTTPS_REQUIRED/u,
  );
  assert.throws(
    () => new RailwayContentAssetStore({ ...base, endpoint: 'https://t3.storageapi.dev/prefix' }),
    /CONTENT_ASSET_ENDPOINT_MUST_BE_ORIGIN/u,
  );
  assert.throws(
    () => new RailwayContentAssetStore({ ...base, endpoint: 'https://t3.storageapi.dev', bucket: 'Not Valid' }),
    /CONTENT_ASSET_BUCKET_INVALID/u,
  );
  for (const signedReadTtlSeconds of [29, 901]) {
    assert.throws(
      () => new RailwayContentAssetStore({
        ...base, endpoint: 'https://t3.storageapi.dev', signedReadTtlSeconds,
      }),
      /CONTENT_ASSET_READ_TTL_INVALID/u,
    );
  }
});

test('reads a provider reference back, and refuses one that escapes its bucket', () => {
  assert.deepEqual(
    parseRailwayBucketReference(`railway-bucket://${BUCKET}/${KEY}`),
    { bucket: BUCKET, key: KEY },
  );
  for (const reference of [
    `supabase-storage://${BUCKET}/${KEY}`,
    `railway-bucket://${BUCKET}/../other/key`,
    `railway-bucket://${BUCKET}//absolute`,
    `railway-bucket://${BUCKET}`,
    'railway-bucket:///no-bucket',
    `railway-bucket://${BUCKET}/with\\backslash`,
  ]) {
    assert.throws(
      () => parseRailwayBucketReference(reference),
      /CONTENT_ASSET_REFERENCE_(SCHEME_UNSUPPORTED|INVALID)/u,
      `expected ${reference} to be refused`,
    );
  }
});
