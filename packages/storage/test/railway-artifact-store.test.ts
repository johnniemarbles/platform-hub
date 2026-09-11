import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RailwayDurableArtifactStore,
  parseS3Credential,
} from '../src/railway-artifact-store.ts';

const TENANT = 'tenant-a';
const BUCKET = 'expadio-artifacts-jdhhd8oe18xi';
const NOW = new Date('2026-09-11T12:00:00Z');
const SOURCE_ID = 'invocation-1';
const KEY = `tenants/${TENANT}/execution-artifacts/ai_invocation/ai_text/${
  createHash('sha256').update(SOURCE_ID).digest('hex')}`;
const REFERENCE = `railway-bucket://${BUCKET}/${KEY}`;
const TEXT = 'the model said this';
const SHA256 = createHash('sha256').update(new TextEncoder().encode(TEXT)).digest('hex');

const CREDENTIAL = JSON.stringify({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

interface Call { readonly method: string; readonly url: string }

function store(
  respond: (call: Call) => Response,
  calls: Call[] = [],
  credential: string = CREDENTIAL,
): RailwayDurableArtifactStore {
  return new RailwayDurableArtifactStore({
    endpoint: 'https://t3.storageapi.dev',
    bucket: BUCKET,
    region: 'auto',
    credentials: async () => credential,
    residencyTags: ['us'],
    complianceTags: ['encrypted-at-rest'],
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url: String(url) };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
    now: () => NOW,
  });
}

function writeInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    artifactKind: 'AI_TEXT',
    sourceKind: 'AI_INVOCATION',
    sourceId: SOURCE_ID,
    content: TEXT,
    contentType: 'text/plain; charset=utf-8',
    providerKey: 'anthropic',
    connectorKey: 'connector-1',
    capabilityKey: 'ai.text',
    costMinorUnits: 0,
    providerCostOwnership: 'EXPADIO_MANAGED',
    requiredResidencyTags: ['us'],
    requiredComplianceTags: ['encrypted-at-rest'],
    ...overrides,
  } as Parameters<RailwayDurableArtifactStore['write']>[0];
}

function readContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    reference: REFERENCE,
    purpose: 'ai.replay',
    requiredResidencyTags: ['us'],
    requiredComplianceTags: ['encrypted-at-rest'],
    ...overrides,
  } as Parameters<RailwayDurableArtifactStore['readText']>[0];
}

const ABSENT = () => new Response(null, { status: 404 });
const PRESENT = () => new Response(null, {
  status: 200,
  headers: { 'x-amz-meta-content-sha256': SHA256 },
});

test('writes an artifact at a tenant-scoped key', async () => {
  const calls: Call[] = [];
  const result = await store(
    (call) => (call.method === 'HEAD' ? ABSENT() : new Response(null, { status: 200 })),
    calls,
  ).write(writeInput());

  assert.equal(result.contentReference, REFERENCE);
  assert.equal(result.sha256, SHA256);
  assert.equal(result.byteLength, new TextEncoder().encode(TEXT).byteLength);
  assert.equal(
    calls.find((call) => call.method === 'PUT')?.url,
    `https://${BUCKET}.t3.storageapi.dev/${KEY}`,
  );
});

/**
 * An execution artifact is the record of what a provider returned for one
 * invocation. A second write under the same source id is either the same bytes
 * — a replay — or a different answer being passed off as that one.
 */
test('a replay of the same bytes succeeds; different bytes are refused', async () => {
  const calls: Call[] = [];
  const replayed = await store(PRESENT, calls).write(writeInput());
  assert.equal(replayed.sha256, SHA256);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD']);

  await assert.rejects(
    store(() => new Response(null, {
      status: 200,
      headers: { 'x-amz-meta-content-sha256': createHash('sha256').update('other').digest('hex') },
    })).write(writeInput()),
    /ARTIFACT_STORAGE_IMMUTABLE_REPLAY_CONFLICT/u,
  );
});

test('reads an artifact back as text', async () => {
  const result = await store(() => new Response(TEXT, { status: 200 })).readText(readContext());
  assert.equal(result.content, TEXT);
  assert.equal(result.contentReference, REFERENCE);
});

test('refuses an artifact that is not valid UTF-8 rather than substituting characters', async () => {
  await assert.rejects(
    store(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 }))
      .readText(readContext()),
    /TypeError|not valid UTF-8|could not be decoded/iu,
  );
});

test('issues a presigned provider fetch URL that expires when it says it does', async () => {
  const result = await store(ABSENT).issueProviderFetchUrl(readContext());
  const url = new URL(result.providerFetchUrl);
  assert.equal(url.origin, `https://${BUCKET}.t3.storageapi.dev`);
  assert.equal(url.pathname, `/${KEY}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(result.expiresAt, '2026-09-11T12:05:00.000Z');
  assert.ok(!result.providerFetchUrl.includes('wJalrXUtnFEMI'), 'the secret must not appear');
});

/**
 * The check that keeps one tenant's reference from reading another tenant's
 * artifact. It is on the key prefix, not on trust in the caller.
 */
test('a reference only resolves inside the tenant that owns it', async () => {
  for (const reference of [
    `railway-bucket://${BUCKET}/tenants/tenant-b/execution-artifacts/x/y/z`,
    `railway-bucket://${BUCKET}/tenants/${TENANT}/../tenant-b/thing`,
    `railway-bucket://other-bucket/${KEY}`,
    `supabase-storage://${BUCKET}/${KEY}`,
  ]) {
    await assert.rejects(
      store(ABSENT).readText(readContext({ reference })),
      /ARTIFACT_STORAGE_REFERENCE_(INVALID|TENANT_MISMATCH)/u,
      `${reference} must be refused`,
    );
  }
});

test('refuses a residency or compliance requirement the bucket cannot satisfy', async () => {
  await assert.rejects(
    store(ABSENT).write(writeInput({ requiredResidencyTags: ['eu'] })),
    /ARTIFACT_STORAGE_RESIDENCY_REQUIREMENT_UNSATISFIED/u,
  );
  await assert.rejects(
    store(ABSENT).readText(readContext({ requiredComplianceTags: ['hipaa'] })),
    /ARTIFACT_STORAGE_COMPLIANCE_REQUIREMENT_UNSATISFIED/u,
  );
});

/**
 * A credential missing its secret would otherwise be signed with an empty key,
 * and the 403 that came back would read as a storage outage rather than a
 * misconfiguration.
 */
test('reads the leased credential strictly', () => {
  assert.deepEqual(
    parseS3Credential(CREDENTIAL),
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  );
  assert.deepEqual(
    parseS3Credential(JSON.stringify({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' })),
    { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' },
  );
  for (const raw of [
    'not json',
    '"a string"',
    '[]',
    JSON.stringify({ accessKeyId: 'a' }),
    JSON.stringify({ secretAccessKey: 'b' }),
    JSON.stringify({ accessKeyId: 'a', secretAccessKey: '   ' }),
    JSON.stringify({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: '' }),
  ]) {
    assert.throws(
      () => parseS3Credential(raw),
      /ARTIFACT_STORAGE_CREDENTIAL_MALFORMED/u,
      `${raw} must be refused`,
    );
  }
});

test('refuses an empty credential before signing anything', async () => {
  await assert.rejects(
    store(ABSENT, [], '   ').write(writeInput()),
    /ARTIFACT_STORAGE_CREDENTIAL_UNAVAILABLE/u,
  );
});
