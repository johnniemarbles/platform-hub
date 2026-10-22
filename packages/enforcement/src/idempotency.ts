/**
 * Idempotency enforcement for writes to the hub.
 *
 * Plan V3.1 rule: "every write takes an idempotency key; slow work returns an
 * operation ID and finishes as an event; a refusal is a typed result with a reason."
 * Also §Reliability rules: "keys are scoped per tenant and operation, the provider's
 * own transaction ID is stored, and a reconciliation job compares both, so a retry
 * results in one external payment or message."
 *
 * This module implements the scoped-key side. The store is pluggable (Postgres in
 * production; the in-memory store below is for tests and the dev loop).
 */
import { refusal, type Refusal } from '@platform-hub/contracts';

export interface IdempotencyKey {
  readonly tenantId: string;
  readonly operation: string;      // e.g. 'communication.email.send'
  readonly key: string;            // the caller's idempotency key
}

export interface IdempotencyRecord<Result> {
  readonly first: Result;
  readonly storedAt: Date;
}

export interface IdempotencyStore<Result> {
  get(key: IdempotencyKey): Promise<IdempotencyRecord<Result> | undefined>;
  /** Store ONLY if absent; returns the first-written record (yours, or someone else's). */
  putIfAbsent(key: IdempotencyKey, result: Result, now: Date): Promise<IdempotencyRecord<Result>>;
}

/**
 * Executes `fn` idempotently for the given scoped key. If the key already has a
 * stored result, returns it without calling `fn`. If `fn` is called and succeeds,
 * stores its result and returns it. The provider's own transaction ID lives in
 * `Result`; this helper never fabricates one.
 */
export async function executeIdempotent<Result>(
  key: IdempotencyKey,
  store: IdempotencyStore<Result>,
  fn: () => Promise<Result>,
  now: () => Date = () => new Date(),
): Promise<{ ok: true; result: Result; replayed: boolean }> {
  const existing = await store.get(key);
  if (existing) return { ok: true as const, result: existing.first, replayed: true };
  const first = await fn();
  const stored = await store.putIfAbsent(key, first, now());
  return { ok: true as const, result: stored.first, replayed: stored.first !== first };
}

/** In-memory implementation. Not for production; a Postgres-backed store ships with hub-api. */
export class InMemoryIdempotencyStore<Result> implements IdempotencyStore<Result> {
  readonly #records = new Map<string, IdempotencyRecord<Result>>();
  readonly #id = (k: IdempotencyKey) => `${k.tenantId}\u0000${k.operation}\u0000${k.key}`;

  async get(key: IdempotencyKey): Promise<IdempotencyRecord<Result> | undefined> {
    return this.#records.get(this.#id(key));
  }
  async putIfAbsent(key: IdempotencyKey, result: Result, now: Date): Promise<IdempotencyRecord<Result>> {
    const id = this.#id(key);
    const existing = this.#records.get(id);
    if (existing) return existing;
    const record: IdempotencyRecord<Result> = { first: result, storedAt: now };
    this.#records.set(id, record);
    return record;
  }
}

/** Explicit "this is a replay" refusal, when callers want to reject rather than return the prior result. */
export const refuseReplay = (traceId: string): Refusal => refusal('IDEMPOTENCY_REPLAY', traceId);
