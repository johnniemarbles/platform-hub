import { Pool } from 'pg';
import type { IdempotencyKey, IdempotencyRecord, IdempotencyStore } from '@platform-hub/enforcement';

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] | readonly Row[] }>;
}

/**
 * Postgres-backed idempotency store. UNIQUE index on
 * (tenant_id, operation, key) serialises concurrent writers.
 */
export class PostgresIdempotencyStore<Result> implements IdempotencyStore<Result> {
  readonly pool: Queryable;

  constructor(pool: Queryable) {
    this.pool = pool;
  }

  async get(key: IdempotencyKey): Promise<IdempotencyRecord<Result> | undefined> {
    const r = await this.pool.query<{ first: Result; stored_at: string }>(
      `SELECT first_result AS first, stored_at::text AS stored_at
         FROM platform.hub_idempotency
        WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [key.tenantId, key.operation, key.key],
    );
    const row = r.rows[0];
    return row ? { first: row.first, storedAt: new Date(row.stored_at) } : undefined;
  }

  async putIfAbsent(key: IdempotencyKey, result: Result, now: Date): Promise<IdempotencyRecord<Result>> {
    const res = await this.pool.query<{ inserted: number }>(
      `INSERT INTO platform.hub_idempotency (tenant_id, operation, key, first_result, stored_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING 1 AS inserted`,
      [key.tenantId, key.operation, key.key, JSON.stringify(result), now],
    );
    if (res.rows && res.rows.length > 0) {
      return { first: result, storedAt: now };
    }
    const existing = await this.get(key);
    if (!existing) throw new Error('idempotency row not found after upsert');
    return existing;
  }
}
