/**
 * node-postgres-backed Db for production.
 *
 * Each `begin()` checks out a dedicated client from the pool. Clients are
 * returned to the pool on commit or rollback, so a request that forgets to
 * finish its transaction cannot keep a connection open.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Db, DbClient, QueryResult, Transaction } from './db.ts';

export function dbFromPool(pool: Pool): Db {
  const asClient = (c: Pool | PoolClient): DbClient => ({
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const r = await c.query<Row & QueryResultRow>(sql, [...params]);
      return { rows: r.rows } satisfies QueryResult<Row>;
    },
    async exec(sql: string) { await c.query(sql); },
  });
  const base = asClient(pool);
  return {
    ...base,
    async begin(): Promise<Transaction> {
      const client = await pool.connect();
      await client.query('BEGIN');
      const txBase = asClient(client);
      let released = false;
      const release = () => { if (!released) { released = true; client.release(); } };
      return {
        ...txBase,
        async commit() { try { await client.query('COMMIT'); } finally { release(); } },
        async rollback() { try { await client.query('ROLLBACK'); } finally { release(); } },
      };
    },
    async close() { await pool.end(); },
  };
}
