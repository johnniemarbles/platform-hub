/**
 * The small database shim hub-api runs through.
 *
 * In production it wraps a `pg.Pool`. In tests it accepts a PGlite instance.
 * The two live behind a tiny async interface so routes don't branch on it.
 * Everything that reads tenant data MUST go through `withRequestContext`,
 * which opens a transaction, calls `platform.set_request_context(...)` so
 * the GUCs are visible, and rolls back automatically on error.
 */
import type { CredentialClass } from '@platform-hub/contracts';

export interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface DbClient {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<void>;
}

export interface Transaction extends DbClient {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Db extends DbClient {
  begin(): Promise<Transaction>;
  close(): Promise<void>;
}

export interface RequestContext {
  readonly tenantId: string;
  readonly appId: string;
  readonly hierarchyScope: string;
  readonly credentialClass: CredentialClass;
  readonly grantId?: string;
}

/**
 * Opens a transaction, sets the server-side GUCs from the verified scope token,
 * runs `fn`, commits. On throw, rolls back. The context never leaves the tx.
 */
export async function withRequestContext<T>(db: Db, ctx: RequestContext, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.begin();
  try {
    await tx.query(
      'SELECT platform.set_request_context($1, $2, $3, $4, $5)',
      [ctx.tenantId, ctx.appId, ctx.hierarchyScope, ctx.credentialClass, ctx.grantId ?? null],
    );
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    throw e;
  }
}
