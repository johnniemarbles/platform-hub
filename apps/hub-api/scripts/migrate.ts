/**
 * Apply every file in infra/db/migrations/ to DATABASE_URL, in filename order.
 *
 * Tracks applied files in platform.schema_migrations so re-runs are idempotent.
 * A migration that fails mid-way leaves the schema_migrations row absent, so a
 * retry attempts it again. Each migration runs inside its own transaction, and
 * every file is expected to be transaction-safe (BEGIN/COMMIT in the file itself
 * nests inside this outer transaction, which Postgres allows).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'infra', 'db', 'migrations');

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) { console.error('DATABASE_URL is required'); process.exit(2); }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS platform;
      CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      );
    `);
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIG_DIR, file), 'utf8');
      // Simple checksum: sha256 hex of the file contents.
      const { createHash } = await import('node:crypto');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM platform.schema_migrations WHERE filename = $1', [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          console.error(`migration ${file} already applied with a different checksum; refusing`);
          process.exit(3);
        }
        continue;
      }
      process.stdout.write(`applying ${file} ... `);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO platform.schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        process.stdout.write('ok\n');
      } catch (e) {
        await client.query('ROLLBACK');
        process.stdout.write('failed\n');
        throw e;
      } finally { client.release(); }
    }
    console.log('migrations complete');
  } finally { await pool.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
