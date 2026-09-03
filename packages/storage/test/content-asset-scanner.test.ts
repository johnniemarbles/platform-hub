import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpContentAssetScanner } from '../src/content-asset-scanner.ts';

const tenantId = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const organizationId = 'c56a4180-65aa-42ec-a945-5fd21dec0539';
const assetId = 'c56a4180-65aa-42ec-a945-5fd21dec0540';
const objectReference = `content-assets/${tenantId}/${organizationId}/${assetId}`;
const sha256 = 'a'.repeat(64);
const request = {
  tenantId,
  organizationId,
  assetId,
  objectReference,
  contentType: 'application/pdf',
  byteLength: 100,
  sha256,
  correlationId: 'scan:1',
};

test('scanner authenticates server-side and accepts an identity-bound clean verdict', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const scanner = new HttpContentAssetScanner({
    endpoint: 'https://scanner.internal.example/v1/assets/scan',
    accessToken: async (lease) => {
      assert.equal(lease.purpose, 'content-asset.malware-scan');
      return 'leased-platform-token';
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        assetId,
        objectReference,
        sha256,
        verdict: 'CLEAN',
        reasonKey: 'NO_THREATS_FOUND',
        engine: 'clamav',
        engineVersion: '1.4.3',
        signatureVersion: '20260903',
        scannedAt: '2026-09-03T10:00:00.000Z',
      });
    },
  });

  const result = await scanner.scan(request);
  assert.equal(result.verdict, 'CLEAN');
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer leased-platform-token');
  assert.doesNotMatch(String(calls[0]?.init?.body), /leased-platform-token/);
});

test('scanner fails closed on provider and identity errors', async () => {
  const unavailable = new HttpContentAssetScanner({
    endpoint: 'https://scanner.internal.example/v1/assets/scan',
    accessToken: async () => 'token',
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(() => unavailable.scan(request), /PROVIDER_FAILED:503/);

  const mismatched = new HttpContentAssetScanner({
    endpoint: 'https://scanner.internal.example/v1/assets/scan',
    accessToken: async () => 'token',
    fetchImpl: async () => Response.json({
      assetId,
      objectReference,
      sha256: 'b'.repeat(64),
      verdict: 'CLEAN',
      reasonKey: 'NO_THREATS_FOUND',
      engine: 'clamav',
      engineVersion: '1.4.3',
      signatureVersion: '20260903',
      scannedAt: '2026-09-03T10:00:00.000Z',
    }),
  });
  await assert.rejects(() => mismatched.scan(request), /IDENTITY_MISMATCH/);
});

test('scanner rejects insecure endpoints and cross-scope references before access', async () => {
  assert.throws(
    () => new HttpContentAssetScanner({
      endpoint: 'http://scanner.internal.example/v1/assets/scan',
      accessToken: async () => 'token',
    }),
    /HTTPS_REQUIRED/,
  );
  let tokenCalls = 0;
  const scanner = new HttpContentAssetScanner({
    endpoint: 'https://scanner.internal.example/v1/assets/scan',
    accessToken: async () => {
      tokenCalls += 1;
      return 'token';
    },
  });
  await assert.rejects(
    () => scanner.scan({ ...request, objectReference: `content-assets/${tenantId}/other/${assetId}` }),
    /REFERENCE_SCOPE_MISMATCH/,
  );
  assert.equal(tokenCalls, 0);
});
