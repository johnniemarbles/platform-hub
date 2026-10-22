/**
 * Boot the hub-api HTTP server from environment variables.
 *
 * Required:
 *   DATABASE_URL           — Postgres connection string
 *   HUB_API_PORT           — defaults to 3030
 *   SCOPE_TOKEN_ALGORITHM  — 'HS256' (dev) or 'EdDSA' (production)
 *   SCOPE_TOKEN_HS256_SECRET or SCOPE_TOKEN_ED25519_PUBLIC_KEY (PEM)
 *
 * This file is deliberately thin: all behaviour lives in handler.ts/routes.ts.
 */
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { dbFromPool } from './db-pg.ts';
import { makeDispatcher, type HubApiConfig } from './handler.ts';
import { routes } from './routes.ts';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function configureFromEnv(): HubApiConfig {
  const algorithm = (process.env['SCOPE_TOKEN_ALGORITHM'] ?? 'HS256') as 'HS256' | 'EdDSA';
  const pool = new Pool({ connectionString: required('DATABASE_URL') });
  const db = dbFromPool(pool);
  if (algorithm === 'HS256') {
    return { db, algorithm, hs256Secret: required('SCOPE_TOKEN_HS256_SECRET') };
  }
  return { db, algorithm, ed25519PublicKey: required('SCOPE_TOKEN_ED25519_PUBLIC_KEY') };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith('server.ts');
if (isMain) {
  const config = configureFromEnv();
  const handler = makeDispatcher(routes, config);
  const port = Number(process.env['HUB_API_PORT'] ?? 3030);
  const server = createServer((req, res) => { handler(req, res).catch((e) => {
    res.statusCode = 500; res.end(JSON.stringify({ ok: false, code: 'REFUSED' }));
    console.error('[hub-api] uncaught', e);
  }); });
  server.listen(port, () => console.log(`[hub-api] listening on :${port} (${config.algorithm})`));
}
