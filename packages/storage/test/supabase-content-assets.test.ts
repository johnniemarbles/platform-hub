import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { SupabaseContentAssetStore } from '../src/supabase-content-asset-store.ts';

const tenantId = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const organizationId = 'c56a4180-65aa-42ec-a945-5fd21dec0539';
const assetId = 'c56a4180-65aa-42ec-a945-5fd21dec0540';
const content = new TextEncoder().encode('verified lesson content');
const sha256 = createHash('sha256').update(content).digest('hex');
const objectReference = `content-assets/${tenantId}/${organizationId}/${assetId}`;

function store(responses: Response[], calls: Array<{ url: string; init?: RequestInit }>) {
  return new SupabaseContentAssetStore({
    projectUrl: 'https://project.supabase.co',
    bucket: 'private-assets',
    accessToken: async () => 'leased-token',
    residencyTags: ['ca'],
    complianceTags: ['pipeda'],
    signedReadTtlSeconds: 60,
    now: () => new Date('2026-09-03T09:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error('UNEXPECTED_FETCH');
      return response;
    },
  });
}

const write = () => ({
  tenantId,
  organizationId,
  assetId,
  objectReference,
  content,
  contentType: 'text/plain',
  expectedByteLength: content.byteLength,
  expectedSha256: sha256,
  requiredResidencyTags: ['ca'],
  requiredComplianceTags: ['pipeda'],
  correlationId: 'upload:1',
});

test('verified write checks private bucket and returns no credential', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = store([
    Response.json({ id: 'private-assets', public: false }),
    new Response('', { status: 200 }),
  ], calls);
  const result = await adapter.store(write());
  assert.equal(result.sha256, sha256);
  assert.equal(result.byteLength, content.byteLength);
  assert.equal('token' in result, false);
  assert.equal('url' in result, false);
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal((calls[1]?.init?.headers as Record<string, string>)['x-upsert'], 'false');
});

test('write rejects checksum mismatch before provider access', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = store([], calls);
  await assert.rejects(
    () => adapter.store({ ...write(), expectedSha256: 'b'.repeat(64) }),
    /DIGEST_MISMATCH/,
  );
  assert.equal(calls.length, 0);
});

test('immutable replay succeeds only when provider bytes match', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = store([
    Response.json({ id: 'private-assets', public: false }),
    new Response('duplicate', { status: 409 }),
    new Response(content, { status: 200 }),
  ], calls);
  const result = await adapter.store(write());
  assert.equal(result.sha256, sha256);
  assert.equal(calls[2]?.init?.method, 'GET');
});

test('read grants are short-lived, origin-bound and credential-blind', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = store([
    Response.json({ id: 'private-assets', public: false }),
    Response.json({ signedURL: '/object/sign/private-assets/path?token=short-lived' }),
  ], calls);
  const grant = await adapter.issueReadGrant({
    tenantId,
    organizationId,
    assetId,
    objectReference,
    purpose: 'learning.player',
    requiredResidencyTags: ['ca'],
    requiredComplianceTags: ['pipeda'],
  });
  assert.match(grant.url, /^https:\/\/project\.supabase\.co\/storage\/v1\//);
  assert.equal(grant.expiresAt, '2026-09-03T09:01:00.000Z');
  assert.equal('credential' in grant, false);
  assert.equal(calls[1]?.init?.cache, 'no-store');
});

test('adapter rejects public buckets and cross-scope references', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = store([Response.json({ id: 'private-assets', public: true })], calls);
  await assert.rejects(() => adapter.store(write()), /PRIVATE_BUCKET_REQUIRED/);
  await assert.rejects(
    () => adapter.issueReadGrant({
      tenantId,
      organizationId,
      assetId,
      objectReference: `content-assets/${tenantId}/other/${assetId}`,
      purpose: 'learning.player',
      requiredResidencyTags: ['ca'],
      requiredComplianceTags: ['pipeda'],
    }),
    /REFERENCE_SCOPE_MISMATCH/,
  );
});
