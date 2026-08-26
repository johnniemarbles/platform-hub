import type { PostgresClient, PostgresPool } from '@expadio/postgres-runtime';
import type { CommunicationDispatchPort, PreparedCommunicationDispatch } from './dispatch.ts';
import { PostgresCommunicationDeliveryRepository } from '@expadio/postgres-runtime/src/delivery.ts';
import type { CommunicationDeliveryState } from './delivery-state.ts';

export interface CommunicationPayloadStore {
  load(tenantId: string, deliveryId: string): Promise<PreparedCommunicationDispatch>;
}

export interface CommunicationQueueWorkerConfig {
  readonly pool: PostgresPool;
  readonly dispatchPort: CommunicationDispatchPort;
  readonly payloadStore: CommunicationPayloadStore;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
}

export class CommunicationQueueWorker {
  readonly #pool: PostgresPool;
  readonly #dispatchPort: CommunicationDispatchPort;
  readonly #payloadStore: CommunicationPayloadStore;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  #running: boolean = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(config: CommunicationQueueWorkerConfig) {
    this.#pool = config.pool;
    this.#dispatchPort = config.dispatchPort;
    this.#payloadStore = config.payloadStore;
    this.#pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.#maxAttempts = config.maxAttempts ?? 5;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleNext(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#poll().finally(() => {
        this.#scheduleNext();
      });
    }, this.#pollIntervalMs);
  }

  async #poll(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      
      // Select one pending delivery with a transaction-safe lock
      const result = await client.query(`
        SELECT delivery_id, tenant_id, attempt_count, state
          FROM platform.communication_deliveries
         WHERE state = 'PENDING'
           AND (updated_at <= NOW() - INTERVAL '1 minute' OR attempt_count = 0)
         LIMIT 1
           FOR UPDATE SKIP LOCKED
      `);

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return; // No pending deliveries
      }

      const row = result.rows[0] as any;
      const deliveryId = row.delivery_id;
      const tenantId = row.tenant_id;
      let attemptCount = row.attempt_count || 0;

      const payload = await this.#payloadStore.load(tenantId, deliveryId);
      const dispatchResult = await this.#dispatchPort.dispatch(payload);

      const occurredAt = new Date().toISOString();
      const repo = new PostgresCommunicationDeliveryRepository(client);

      if (dispatchResult.state === 'SENT' || dispatchResult.state === 'QUEUED') {
        const toState: CommunicationDeliveryState = dispatchResult.state === 'QUEUED' ? 'ACCEPTED' : 'SENT';
        await repo.applyTransition({
          tenantId,
          deliveryId,
          transition: {
            from: 'PENDING',
            to: toState,
            occurredAt,
            reasonCode: dispatchResult.reasonCode,
          },
          providerMessageId: dispatchResult.messageId ?? undefined,
          incrementAttempt: true,
        });
      } else {
        // REFUSED or FAILED
        const isRetryable = [
          'PROVIDER_UNAVAILABLE',
          'RATE_LIMITED',
          'THROTTLED'
        ].includes(dispatchResult.reasonCode);
        
        attemptCount++;

        if (isRetryable && attemptCount < this.#maxAttempts) {
          // Retryable failure - keep in PENDING or update attempt count
          await repo.recordAttempt({
            tenantId,
            deliveryId,
            occurredAt,
            reasonCode: dispatchResult.reasonCode,
            reason: dispatchResult.refusalReason,
          });
          // Note: exponential backoff logic can be implemented by setting updated_at or next_attempt_at in DB
          // For now, recordAttempt updates updated_at, and the poll query filters by updated_at <= NOW() - ...
          // To strictly use exponential backoff, we'd add next_attempt_at column to communication_deliveries.
        } else {
          // Terminal failure
          await repo.applyTransition({
            tenantId,
            deliveryId,
            transition: {
              from: 'PENDING',
              to: 'FAILED',
              occurredAt,
              reasonCode: dispatchResult.reasonCode,
              reason: dispatchResult.refusalReason,
            },
            incrementAttempt: true,
          });
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error processing communication queue:', error);
    } finally {
      client.release?.();
    }
  }
}
