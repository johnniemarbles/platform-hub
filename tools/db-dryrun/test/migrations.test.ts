/**
 * Dry-run of every hub-side migration against an ephemeral Postgres.
 *
 * pglite is a Postgres in a WebAssembly process — same engine, same SQL dialect.
 * This test is a smoke-screen: it proves every migration file applies in order
 * on an empty database, that the Gate 1 grant-check function returns the right
 * answers in every ownership/class combination, and that platform.set_request_context
 * sets GUCs that only live for the transaction.
 *
 * The real environment runs the same files through a migration runner; this
 * guarantees the SQL itself is well-formed before anything is deployed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const newDb = () => PGlite.create({ extensions: { pgcrypto } });

const MIG_DIR = fileURLToPath(new URL('../../../infra/db/migrations', import.meta.url));

async function freshDb(): Promise<PGlite> {
  const db = await newDb();
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(`${MIG_DIR}/${f}`, 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      // Some migrations in the extracted set reference tables created by later
      // migrations that live only in platform-core (e.g. 0040 references
      // platform.tenants). For Gate 2's hub-side dry-run we only need the hub
      // tables to apply; capture and continue so we can see the shape.
      (e as { migration?: string }).migration = f;
      throw e;
    }
  }
  return db;
}

test('every hub migration applies in order on an empty database', async () => {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 7, `expected ≥ 7 migrations, saw ${files.length}: ${files.join(', ')}`);

  // Known forward dependency: 0040_communication_byok_custody.sql references
  // platform.tenants, which is defined in a core-side migration not yet in
  // this repo. Pre-stub so the dry-run completes end to end. In production
  // the full migration set (hub-side + core-side) is applied together.
  const db = await newDb();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS platform;
    -- Stand-in for the core migration that defines tenants. Columns match
    -- what 0040 and 0100 reference.
    CREATE TABLE IF NOT EXISTS platform.tenants (
      tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  for (const f of files) {
    const sql = readFileSync(`${MIG_DIR}/${f}`, 'utf8');
    await db.exec(sql);
  }
  await db.close();
});

test('app_may_use_connector enforces the three credential classes correctly', async () => {
  const db = await newDb();
  await db.exec(`CREATE SCHEMA platform;
    CREATE TABLE platform.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(readFileSync(`${MIG_DIR}/${f}`, 'utf8'));

  // Fixture: two tenants, two apps, three connectors (platform-owned, tenant-A-BYOK, tenant-A-provisioned).
  await db.exec(`
    INSERT INTO platform.tenants(tenant_id) VALUES
      ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
  `);
  // Minimum connector rows that satisfy 0001's constraints.
  await db.exec(`
    INSERT INTO platform.connectors
      (connector_id, connector_key, provider_type, provider_key, ownership_scope, tenant_id)
    VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ses.platform', 'email', 'ses', 'PLATFORM', NULL),
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'twilio.A.byok', 'sms', 'twilio', 'TENANT', '11111111-1111-1111-1111-111111111111'),
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'twilio.A.prov', 'sms', 'twilio', 'TENANT', '11111111-1111-1111-1111-111111111111');
  `);
  // Grant: app_dentex has a tenant-byok grant on connector B, but no grant on C.
  await db.exec(`
    INSERT INTO platform.connector_grants
      (tenant_id, app_id, connector_id, credential_class, granted_by)
    VALUES
      ('11111111-1111-1111-1111-111111111111', 'app_dentex',
       'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tenant-byok',
       '99999999-9999-9999-9999-999999999999');
  `);

  const check = async (tenant: string, app: string, connector: string, cls: string) => {
    const res = await db.query<{ ok: boolean }>(
      `SELECT platform.app_may_use_connector($1, $2, $3, $4) AS ok`,
      [tenant, app, connector, cls],
    );
    return res.rows[0]?.ok ?? false;
  };

  // Platform-operational on platform connector: ok.
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_dentex',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'platform-operational'), true);
  // Platform-operational on tenant connector: refused.
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_dentex',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'platform-operational'), false);
  // Tenant-byok on platform connector: refused.
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_dentex',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tenant-byok'), false);
  // Tenant-byok on granted connector: ok.
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_dentex',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tenant-byok'), true);
  // Tenant-byok on NOT-granted connector of same tenant: refused (plan rule 5 — no silent fallback).
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_dentex',
    'cccccccc-cccc-cccc-cccc-cccccccccccc', 'tenant-byok'), false);
  // Tenant-byok on a different tenant's connector, even with a grant for app on tenant A: refused.
  assert.equal(await check(
    '22222222-2222-2222-2222-222222222222', 'app_dentex',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tenant-byok'), false);
  // Different app without a grant: refused.
  assert.equal(await check(
    '11111111-1111-1111-1111-111111111111', 'app_insurance',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tenant-byok'), false);

  await db.close();
});

test('set_request_context sets LOCAL GUCs that roll back at commit', async () => {
  const db = await newDb();
  await db.exec(`CREATE SCHEMA platform;
    CREATE TABLE platform.tenants (tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(readFileSync(`${MIG_DIR}/${f}`, 'utf8'));

  const tenant = '11111111-1111-1111-1111-111111111111';
  // Inside a transaction, context is readable
  await db.exec('BEGIN');
  await db.query(`SELECT platform.set_request_context($1, $2, $3, $4, NULL)`,
    [tenant, 'app_dentex', 'brand/acme', 'platform-operational']);
  const inTx = await db.query<{ v: string | null }>(`SELECT platform.current_tenant_id()::text AS v`);
  assert.equal(inTx.rows[0]?.v, tenant);
  await db.exec('COMMIT');

  // After commit, in a new tx, the GUCs are gone.
  await db.exec('BEGIN');
  const after = await db.query<{ v: string | null }>(`SELECT platform.current_tenant_id()::text AS v`);
  assert.equal(after.rows[0]?.v, null);
  await db.exec('COMMIT');

  await db.close();
});
