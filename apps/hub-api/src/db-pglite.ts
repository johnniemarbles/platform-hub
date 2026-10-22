/**
 * PGlite-backed Db for tests. Not for production.
 *
 * PGlite runs serially inside one WebAssembly instance, so a nested `begin()`
 * would wedge: this file threads a mutex over begin/commit/rollback so each
 * transaction completes before the next starts.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { Db, DbClient, QueryResult, Transaction } from './db.ts';

export function dbFromPglite(pg: PGlite): Db {
  const base: DbClient = {
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const r = await pg.query<Row>(sql, [...params]);
      return { rows: r.rows } satisfies QueryResult<Row>;
    },
    async exec(sql: string) { await pg.exec(sql); },
  };

  let busy: Promise<void> = Promise.resolve();
  return {
    ...base,
    async begin(): Promise<Transaction> {
      // Serialise begin() calls so one transaction completes before the next starts.
      const prev = busy;
      let release!: () => void;
      busy = new Promise((r) => { release = r; });
      await prev;
      await pg.exec('BEGIN');
      let settled = false;
      const settle = () => { if (!settled) { settled = true; release(); } };
      return {
        ...base,
        async commit() { await pg.exec('COMMIT'); settle(); },
        async rollback() { await pg.exec('ROLLBACK'); settle(); },
      };
    },
    async close() { await pg.close(); },
  };
}
