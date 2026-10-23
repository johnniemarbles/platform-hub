import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { signScopeToken, SCOPE_TOKEN_SECRET_MIN_BYTES, type ScopeTokenClaims } from '@platform-hub/contracts';
import { dbFromPglite } from '../src/db-pglite.ts';
import { makeDispatcher } from '../src/handler.ts';
import { credentialRoutes } from '../src/routes/credentials.ts';
import { PostgresIdempotencyStore } from '../src/idempotency-postgres.ts';

const MIG_DIR = fileURLToPath(new URL('../../../infra/db/migrations', import.meta.url));
const SECRET = 'a'.repeat(SCOPE_TOKEN_SECRET_MIN_BYTES);

async function freshDb() {
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec(`CREATE SCHEMA platform;
    CREATE TABLE platform.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid());`);
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await pg.exec(readFileSync(`${MIG_DIR}/${f}`, 'utf8'));
  return pg;
}

async function captureResponse(
  dispatcher: ReturnType<typeof makeDispatcher>,
  options: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
) {
  const server = createServer((req, res) => void dispatcher(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  const port = addr.port;
  try {
    const init: RequestInit = {
      method: options.method,
      headers: {
        ...(options.headers ?? {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };
    const r = await fetch(`http://127.0.0.1:${port}${options.path}`, init);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const tenantUuid = '11111111-1111-1111-1111-111111111111';
const userUuid = '42424242-4242-4242-4242-424242424242';
const grantUuid = '88888888-8888-8888-8888-888888888888';
const baseClaims = (overrides: Partial<ScopeTokenClaims> = {}): ScopeTokenClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'platform',
    aud: 'hub',
    sub: userUuid,
    kind: 'user',
    tenantId: tenantUuid,
    appId: 'app_dentex',
    permissions: ['credentials.read', 'credential.revoke'],
    hierarchyScope: 'brand/acme',
    credentialClass: 'platform-operational',
    jti: `tok_${now}`,
    iat: now - 10,
    exp: now + 300,
    ...overrides,
  };
};

async function seedFixture(pg: PGlite) {
  await pg.exec(`INSERT INTO platform.tenants(tenant_id) VALUES ('${tenantUuid}');`);
  await pg.exec(`
    INSERT INTO platform.connectors
      (connector_id, connector_key, provider_type, provider_key, ownership_scope, tenant_id)
    VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ses.platform', 'email', 'ses', 'PLATFORM', NULL),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'twilio.A.byok', 'sms', 'twilio', 'TENANT', '${tenantUuid}'),
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'twilio.A.prov', 'sms', 'twilio', 'TENANT', '${tenantUuid}');
  `);
  await pg.exec(`
    INSERT INTO platform.connector_credentials
      (credential_id, connector_id, credential_ref, state)
    VALUES
      ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'vault://secret/twilio/a', 'ACTIVE');
  `);
  await pg.exec(`
    INSERT INTO platform.connector_grants
      (grant_id, tenant_id, app_id, connector_id, credential_class, granted_by)
    VALUES
      ('${grantUuid}', '${tenantUuid}', 'app_dentex', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tenant-byok', '${userUuid}');
  `);
}

test('credentials route - platform-operational token sees PLATFORM + tenant connectors', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims({ credentialClass: 'platform-operational' }), SECRET);
  const res = await captureResponse(d, {
    method: 'GET',
    path: '/v1/credentials',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 200);
  const result = res.body['result'] as { count: number; credentials: Array<{ connectorKey: string }> };
  assert.equal(result.count, 3);
  const keys = result.credentials.map((c) => c.connectorKey);
  assert.ok(keys.includes('ses.platform'));
  assert.ok(keys.includes('twilio.A.byok'));
  assert.ok(keys.includes('twilio.A.prov'));
});

test('credentials route - tenant-byok token with live grant sees exactly that connector', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims({ credentialClass: 'tenant-byok', grantId: grantUuid }), SECRET);
  const res = await captureResponse(d, {
    method: 'GET',
    path: '/v1/credentials',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 200);
  const result = res.body['result'] as { count: number; credentials: Array<{ connectorKey: string }> };
  assert.equal(result.count, 1);
  assert.equal(result.credentials[0]?.connectorKey, 'twilio.A.byok');
});

test('credentials route - tenant-byok token without grant sees nothing', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims({ appId: 'app_other', credentialClass: 'tenant-byok', grantId: grantUuid }), SECRET);
  const res = await captureResponse(d, {
    method: 'GET',
    path: '/v1/credentials',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 200);
  const result = res.body['result'] as { count: number; credentials: Array<{ connectorKey: string }> };
  assert.equal(result.count, 0);
});

test('credentials route - POST .../revoke with bad body returns 500 refusal', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims(), SECRET);
  const res = await captureResponse(d, {
    method: 'POST',
    path: '/v1/credentials/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/revoke',
    headers: { authorization: `Bearer ${token}` },
    body: { maxExposureSeconds: 120 }, // missing attestationText & idempotencyKey
  });

  assert.equal(res.status, 500);
  assert.equal(res.body['code'], 'REFUSED');
});

test('credentials route - POST .../revoke twice with same idempotencyKey returns same attestation with replayed=true', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims(), SECRET);
  const payload = {
    attestationText: 'compromised key rotated',
    maxExposureSeconds: 300,
    correlationId: '00000000-0000-0000-0000-000000000001',
    idempotencyKey: 'idemp_revoke_1',
  };

  const res1 = await captureResponse(d, {
    method: 'POST',
    path: '/v1/credentials/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/revoke',
    headers: { authorization: `Bearer ${token}` },
    body: payload,
  });

  assert.equal(res1.status, 200);
  const body1 = res1.body['result'] as { attestation_id: string; replayed: boolean };
  assert.equal(body1.replayed, false);
  assert.ok(body1.attestation_id);

  const res2 = await captureResponse(d, {
    method: 'POST',
    path: '/v1/credentials/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/revoke',
    headers: { authorization: `Bearer ${token}` },
    body: payload,
  });

  assert.equal(res2.status, 200);
  const body2 = res2.body['result'] as { attestation_id: string; replayed: boolean };
  assert.equal(body2.replayed, true);
  assert.equal(body2.attestation_id, body1.attestation_id);
});

test('credentials route - second attempt with different idempotencyKey on already-REVOKED credential fails', async () => {
  const pg = await freshDb();
  await seedFixture(pg);

  const idempotency = new PostgresIdempotencyStore<any>(pg);
  const routes = credentialRoutes(idempotency);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });

  const token = signScopeToken(baseClaims(), SECRET);
  const payload1 = {
    attestationText: 'first revocation',
    maxExposureSeconds: 300,
    correlationId: '00000000-0000-0000-0000-000000000001',
    idempotencyKey: 'idemp_revoke_1',
  };

  const res1 = await captureResponse(d, {
    method: 'POST',
    path: '/v1/credentials/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/revoke',
    headers: { authorization: `Bearer ${token}` },
    body: payload1,
  });
  assert.equal(res1.status, 200);

  // Second attempt with a DIFFERENT idempotency key
  const payload2 = {
    attestationText: 'second revocation attempt',
    maxExposureSeconds: 300,
    correlationId: '00000000-0000-0000-0000-000000000002',
    idempotencyKey: 'idemp_revoke_2',
  };

  const res2 = await captureResponse(d, {
    method: 'POST',
    path: '/v1/credentials/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/revoke',
    headers: { authorization: `Bearer ${token}` },
    body: payload2,
  });

  // Fails with 500 (CONNECTOR_NOT_FOUND because already revoked)
  assert.equal(res2.status, 500);
  assert.equal(res2.body['code'], 'REFUSED');
});
