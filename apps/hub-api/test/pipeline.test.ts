/**
 * End-to-end integration tests for the hub-api pipeline on PGlite.
 *
 * Each test:
 *   1. applies every migration against a fresh PGlite,
 *   2. seeds a tenant row,
 *   3. signs a scope token with a known secret,
 *   4. invokes makeDispatcher() directly against an in-memory request,
 *   5. asserts the response, status and server-side GUCs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { signScopeToken, SCOPE_TOKEN_SECRET_MIN_BYTES, type ScopeTokenClaims } from '@platform-hub/contracts';
import { dbFromPglite } from '../src/db-pglite.ts';
import { makeDispatcher } from '../src/handler.ts';
import { routes } from '../src/routes.ts';

const MIG_DIR = new URL('../../../infra/db/migrations', import.meta.url).pathname;
const SECRET = 'a'.repeat(SCOPE_TOKEN_SECRET_MIN_BYTES);

async function freshDb() {
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  await pg.exec(`CREATE SCHEMA platform;
    CREATE TABLE platform.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid());`);
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await pg.exec(readFileSync(`${MIG_DIR}/${f}`, 'utf8'));
  return pg;
}

async function captureResponse(dispatcher: ReturnType<typeof makeDispatcher>, options: { method: string; path: string; headers?: Record<string, string> }) {
  const server = createServer((req, res) => void dispatcher(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  const port = addr.port;
  try {
    const init: RequestInit = options.headers !== undefined
      ? { method: options.method, headers: options.headers }
      : { method: options.method };
    const r = await fetch(`http://127.0.0.1:${port}${options.path}`, init);
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const tenantUuid = '11111111-1111-1111-1111-111111111111';
const baseClaims = (overrides: Partial<ScopeTokenClaims> = {}): ScopeTokenClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'platform', aud: 'hub',
    sub: 'usr_42', kind: 'user',
    tenantId: tenantUuid, appId: 'app_dentex',
    permissions: ['debug.whoami'], hierarchyScope: 'brand/acme',
    credentialClass: 'platform-operational',
    jti: `tok_${now}`, iat: now - 10, exp: now + 300,
    ...overrides,
  };
};

test('health endpoint responds without authentication', async () => {
  const pg = await freshDb();
  await pg.exec(`INSERT INTO platform.tenants(tenant_id) VALUES ('${tenantUuid}')`);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const r = await captureResponse(d, { method: 'GET', path: '/health' });
  assert.equal(r.status, 200);
  assert.equal(r.body['ok'], true);
  await pg.close();
});

test('a valid scope token flows through verify → enforce → GUC → handler', async () => {
  const pg = await freshDb();
  await pg.exec(`INSERT INTO platform.tenants(tenant_id) VALUES ('${tenantUuid}')`);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const token = signScopeToken(baseClaims(), SECRET);
  const r = await captureResponse(d, {
    method: 'GET', path: '/v1/_debug/whoami',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const result = r.body['result'] as { claims: { tenantId: string }; serverContext: { tenant: string; app: string; credentialClass: string } };
  assert.equal(result.claims.tenantId, tenantUuid);
  // The GUC the handler sees inside its transaction is set from the TOKEN, not from the request body.
  assert.equal(result.serverContext.tenant, tenantUuid);
  assert.equal(result.serverContext.app, 'app_dentex');
  assert.equal(result.serverContext.credentialClass, 'platform-operational');
  await pg.close();
});

test('a request without a bearer token is refused 401 TOKEN_MALFORMED', async () => {
  const pg = await freshDb();
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const r = await captureResponse(d, { method: 'GET', path: '/v1/_debug/whoami' });
  assert.equal(r.status, 401);
  assert.equal(r.body['code'], 'TOKEN_MALFORMED');
  await pg.close();
});

test('a token signed with another secret is refused 401 TOKEN_SIGNATURE_INVALID', async () => {
  const pg = await freshDb();
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const token = signScopeToken(baseClaims(), 'b'.repeat(SCOPE_TOKEN_SECRET_MIN_BYTES));
  const r = await captureResponse(d, {
    method: 'GET', path: '/v1/_debug/whoami',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body['code'], 'TOKEN_SIGNATURE_INVALID');
  await pg.close();
});

test('an expired token is refused 401 TOKEN_EXPIRED', async () => {
  const pg = await freshDb();
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const now = Math.floor(Date.now() / 1000);
  const token = signScopeToken(baseClaims({ iat: now - 1000, exp: now - 10 }), SECRET);
  const r = await captureResponse(d, {
    method: 'GET', path: '/v1/_debug/whoami',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body['code'], 'TOKEN_EXPIRED');
  await pg.close();
});

test('consecutive requests on the same server do not leak GUCs across transactions', async () => {
  const pg = await freshDb();
  await pg.exec(`
    INSERT INTO platform.tenants(tenant_id) VALUES ('${tenantUuid}'), ('22222222-2222-2222-2222-222222222222');
  `);
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const tokenA = signScopeToken(baseClaims({ tenantId: tenantUuid, appId: 'app_dentex' }), SECRET);
  const tokenB = signScopeToken(baseClaims({ tenantId: '22222222-2222-2222-2222-222222222222', appId: 'app_insurance' }), SECRET);
  const r1 = await captureResponse(d, { method: 'GET', path: '/v1/_debug/whoami', headers: { authorization: `Bearer ${tokenA}` } });
  const r2 = await captureResponse(d, { method: 'GET', path: '/v1/_debug/whoami', headers: { authorization: `Bearer ${tokenB}` } });
  const r1x = r1.body['result'] as { serverContext: { tenant: string; app: string } };
  const r2x = r2.body['result'] as { serverContext: { tenant: string; app: string } };
  assert.equal(r1x.serverContext.tenant, tenantUuid);
  assert.equal(r2x.serverContext.tenant, '22222222-2222-2222-2222-222222222222');
  assert.notEqual(r1x.serverContext.app, r2x.serverContext.app);
  await pg.close();
});

test('unknown routes return 404 REFUSED', async () => {
  const pg = await freshDb();
  const d = makeDispatcher(routes, { db: dbFromPglite(pg), algorithm: 'HS256', hs256Secret: SECRET });
  const r = await captureResponse(d, { method: 'GET', path: '/nope' });
  assert.equal(r.status, 404);
  assert.equal(r.body['code'], 'REFUSED');
  await pg.close();
});
