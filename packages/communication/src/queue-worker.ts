import type { PostgresClient, PostgresPool } from '@expadio/postgres-runtime';
import type { CommunicationDispatchPort, PreparedCommunicationDispatch } from './dispatch.ts';
import type { CommunicationDeliveryRepository } from './delivery-repository.ts';
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

      if (dispatchResult.state === 'SENT' || dispatchResult.state === 'QUEUED') {
        const toState: CommunicationDeliveryState = dispatchResult.state === 'QUEUED' ? 'ACCEPTED' : 'SENT';
        
        await client.query(`
          UPDATE platform.communication_deliveries
             SET state = $3,
                 provider_message_id = COALESCE($4, provider_message_id),
                 attempt_count = attempt_count + 1,
                 last_reason_code = $5,
                 last_reason = $6,
                 accepted_at = CASE WHEN $3 = 'ACCEPTED' THEN COALESCE(accepted_at, $7) ELSE accepted_at END,
                 updated_at = $7
           WHERE tenant_id = $1::uuid AND delivery_id = $2::uuid
        `, [tenantId, deliveryId, toState, dispatchResult.messageId ?? null, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, occurredAt]);

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
          const delayMs = Math.pow(2, attemptCount) * 1000;
          await client.query(`
            UPDATE platform.communication_deliveries
               SET attempt_count = attempt_count + 1,
                   last_reason_code = $3,
                   last_reason = $4,
                   updated_at = NOW() + (interval '1 millisecond' * $5)
             WHERE tenant_id = $1::uuid AND delivery_id = $2::uuid
          `, [tenantId, deliveryId, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, delayMs]);
        } else {
          // Terminal failure
          await client.query(`
            UPDATE platform.communication_deliveries
               SET state = 'FAILED',
                   attempt_count = attempt_count + 1,
                   last_reason_code = $3,
                   last_reason = $4,
                   updated_at = $5
             WHERE tenant_id = $1::uuid AND delivery_id = $2::uuid
          `, [tenantId, deliveryId, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, occurredAt]);
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
