import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { signScopeToken, type ScopeTokenClaims } from '@platform-hub/contracts';
import { InMemoryIdempotencyStore } from '@platform-hub/enforcement';
import { dbFromPglite } from '../src/db-pglite.ts';
import { makeDispatcher, type HubApiConfig } from '../src/handler.ts';
import { communicationsRoutes } from '../src/routes/communications.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const APP_ID = 'app_dentex';

function claims(overrides: Partial<ScopeTokenClaims> = {}): ScopeTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'platform',
    aud: 'hub',
    sub: 'usr_42',
    kind: 'user',
    tenantId: TENANT_ID,
    appId: APP_ID,
    permissions: ['communication.email.send'],
    hierarchyScope: 'brand/acme',
    credentialClass: 'platform-operational',
    jti: 'jti_123',
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

async function setupTestDb() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS platform;

    CREATE OR REPLACE FUNCTION platform.current_tenant_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

    CREATE OR REPLACE FUNCTION platform.current_app_id() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.app_id', true), '') $$;

    CREATE OR REPLACE FUNCTION platform.current_hierarchy_scope() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.hierarchy_scope', true), '') $$;

    CREATE OR REPLACE FUNCTION platform.current_credential_class() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.credential_class', true), '') $$;

    CREATE OR REPLACE FUNCTION platform.current_grant_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.grant_id', true), '')::uuid $$;

    CREATE OR REPLACE FUNCTION platform.set_request_context(
      p_tenant_id uuid,
      p_app_id text,
      p_hierarchy_scope text,
      p_credential_class text,
      p_grant_id uuid
    ) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
      PERFORM set_config('app.app_id', p_app_id, true);
      PERFORM set_config('app.hierarchy_scope', p_hierarchy_scope, true);
      PERFORM set_config('app.credential_class', p_credential_class, true);
      PERFORM set_config('app.grant_id', COALESCE(p_grant_id::text, ''), true);
    END $$;

    CREATE TABLE IF NOT EXISTS platform.connectors (
      connector_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connector_key text NOT NULL UNIQUE,
      provider_type text NOT NULL,
      provider_key text NOT NULL,
      ownership_scope text NOT NULL,
      tenant_id uuid,
      capability_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
      enabled boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS platform.connector_grants (
      grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      app_id text NOT NULL,
      connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id),
      credential_class text NOT NULL,
      granted_by uuid NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS platform.communication_suppressions (
      suppression_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      recipient text NOT NULL,
      channel text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS platform.hub_idempotency_records (
      tenant_id uuid NOT NULL,
      operation text NOT NULL,
      idempotency_key text NOT NULL,
      state text NOT NULL,
      result_payload text,
      trace_id text,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, operation, idempotency_key)
    );
  `);
  return pg;
}

function mockPostRequest(url: string, body: unknown, token?: string): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body));
  const stream = Readable.from([payload]) as unknown as IncomingMessage;
  (stream as any).method = 'POST';
  (stream as any).url = url;
  (stream as any).headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return stream;
}

test('communications-send: scope token without communication.email.send -> 403 TOKEN_SCOPE_MISMATCH', async () => {
  const pg = await setupTestDb();
  const db = dbFromPglite(pg);
  const config: HubApiConfig = { db, algorithm: 'HS256', hs256Secret: SECRET };
  const dispatcher = makeDispatcher(communicationsRoutes(), config);

  const token = signScopeToken(claims({ permissions: ['other.permission'] }), SECRET);
  const req = mockPostRequest('/v1/communications/email/send', {
    to: 'patient@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: {},
    idempotencyKey: 'idemp-1',
  }, token);

  const res = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req, mockRes);
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'TOKEN_SCOPE_MISMATCH');
  await db.close();
});

test('communications-send: tenant has no grant for Resend connector -> 403 CREDENTIAL_NOT_GRANTED', async () => {
  const pg = await setupTestDb();
  const db = dbFromPglite(pg);
  const config: HubApiConfig = { db, algorithm: 'HS256', hs256Secret: SECRET };
  const dispatcher = makeDispatcher(communicationsRoutes(), config);

  const token = signScopeToken(claims(), SECRET);
  const req = mockPostRequest('/v1/communications/email/send', {
    to: 'patient@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: {},
    idempotencyKey: 'idemp-2',
  }, token);

  const res = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req, mockRes);
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CREDENTIAL_NOT_GRANTED');
  await db.close();
});

test('communications-send: scope token with permission + active grant -> ok: true with provider id', async () => {
  const pg = await setupTestDb();
  const db = dbFromPglite(pg);

  await pg.exec(`
    INSERT INTO platform.connectors (connector_id, connector_key, provider_type, provider_key, ownership_scope, capability_keys, enabled)
    VALUES ('22222222-2222-2222-2222-222222222222', 'platform-resend-dev', 'email', 'resend', 'PLATFORM', ARRAY['communication.email.send'], true);
  `);

  const config: HubApiConfig = { db, algorithm: 'HS256', hs256Secret: SECRET };
  const dispatcher = makeDispatcher(communicationsRoutes(), config);

  const token = signScopeToken(claims(), SECRET);
  const req = mockPostRequest('/v1/communications/email/send', {
    to: 'patient@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: { patientName: 'Alice' },
    idempotencyKey: 'idemp-3',
  }, token);

  const res = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req, mockRes);
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.provider, 'resend');
  assert.ok(typeof res.body.result.messageId === 'string');
  await db.close();
});

test('communications-send: recipient has an active suppression -> SUPPRESSED refusal', async () => {
  const pg = await setupTestDb();
  const db = dbFromPglite(pg);

  await pg.exec(`
    INSERT INTO platform.connectors (connector_id, connector_key, provider_type, provider_key, ownership_scope, capability_keys, enabled)
    VALUES ('22222222-2222-2222-2222-222222222222', 'platform-resend-dev', 'email', 'resend', 'PLATFORM', ARRAY['communication.email.send'], true);

    INSERT INTO platform.communication_suppressions (tenant_id, recipient, channel, reason)
    VALUES ('${TENANT_ID}', 'suppressed@example.com', 'email', 'BOUNCE');
  `);

  const config: HubApiConfig = { db, algorithm: 'HS256', hs256Secret: SECRET };
  const dispatcher = makeDispatcher(communicationsRoutes(), config);

  const token = signScopeToken(claims(), SECRET);
  const req = mockPostRequest('/v1/communications/email/send', {
    to: 'suppressed@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: {},
    idempotencyKey: 'idemp-4',
  }, token);

  const res = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req, mockRes);
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SUPPRESSED');
  await db.close();
});

test('communications-send: replay same idempotencyKey -> replayed result', async () => {
  const pg = await setupTestDb();
  const db = dbFromPglite(pg);

  await pg.exec(`
    INSERT INTO platform.connectors (connector_id, connector_key, provider_type, provider_key, ownership_scope, capability_keys, enabled)
    VALUES ('22222222-2222-2222-2222-222222222222', 'platform-resend-dev', 'email', 'resend', 'PLATFORM', ARRAY['communication.email.send'], true);
  `);

  let sendCount = 0;
  const mockSender = async () => {
    sendCount++;
    return { ok: true as const, provider: 'resend', messageId: 'msg_unique_1' };
  };

  const store = new InMemoryIdempotencyStore<any>();
  const config: HubApiConfig = { db, algorithm: 'HS256', hs256Secret: SECRET };
  const dispatcher = makeDispatcher(communicationsRoutes(store, mockSender), config);

  const token = signScopeToken(claims(), SECRET);

  // Send 1
  const req1 = mockPostRequest('/v1/communications/email/send', {
    to: 'patient@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: {},
    idempotencyKey: 'idemp-repeat-key',
  }, token);

  const res1 = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req1, mockRes);
  });

  assert.equal(res1.status, 200);
  assert.equal(sendCount, 1);

  // Send 2 (Replay)
  const req2 = mockPostRequest('/v1/communications/email/send', {
    to: 'patient@example.com',
    templateKey: 'dentex.booking.confirmation',
    parameters: {},
    idempotencyKey: 'idemp-repeat-key',
  }, token);

  const res2 = await new Promise<{ status: number; body: any }>((resolve) => {
    const mockRes = {
      statusCode: 200,
      setHeader() {},
      end(chunk: string) { resolve({ status: mockRes.statusCode, body: JSON.parse(chunk) }); },
    } as unknown as ServerResponse;
    dispatcher(req2, mockRes);
  });

  assert.equal(res2.status, 200);
  assert.equal(sendCount, 1); // Not called second time
  assert.equal(res2.body.result.replayed, true);
  await db.close();
});
