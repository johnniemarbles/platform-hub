export interface SqlQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PostgresClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  release?(): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

import type { CommunicationDispatchPort, PreparedCommunicationDispatch } from './dispatch.ts';
import type { CommunicationDeliveryRepository } from './delivery-repository.ts';
import type { CommunicationDeliveryState } from './delivery-state.ts';

export interface CommunicationPayloadStore {
  load(tenantId: string, deliveryId: string): Promise<PreparedCommunicationDispatch>;
}

export interface WorkerOptions {
  plane: 'TRANSACTIONAL' | 'BULK';
  batchSize?: number;
  workerId: string;
}

export interface CommunicationQueueWorkerConfig extends WorkerOptions {
  readonly pool: PostgresPool;
  readonly dispatchPort: CommunicationDispatchPort;
  readonly payloadStore: CommunicationPayloadStore;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
}

export class GovernedQueueWorker {
  readonly #pool: PostgresPool;
  readonly #options: WorkerOptions;
  readonly #dispatchPort: CommunicationDispatchPort;
  readonly #payloadStore: CommunicationPayloadStore;
  readonly #pollIntervalMs: number;
  readonly #maxAttempts: number;
  #running: boolean = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(config: CommunicationQueueWorkerConfig) {
    this.#pool = config.pool;
    this.#options = {
      plane: config.plane,
      workerId: config.workerId
    };
    if (config.batchSize !== undefined) {
      this.#options.batchSize = config.batchSize;
    }
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
      this.claimNextBatch().finally(() => {
        this.#scheduleNext();
      });
    }, this.#pollIntervalMs);
  }

  /**
   * Claims pending delivery jobs strictly matching the worker's assigned plane.
   * Transactional workers never process bulk queues, and bulk workers never starve OTPs.
   */
  async claimNextBatch(): Promise<any[]> {
    const client = await this.#pool.connect();
    const batchSize = this.#options.batchSize || 10;
    
    try {
      await client.query('BEGIN');
      
      // Strict two-plane queue isolation with SKIP LOCKED
      const claimQuery = `
        SELECT id, tenant_id, organization_id, channel, connector_id, payload, attempts, delivery_id, attempt_count
        FROM platform.communication_deliveries
        WHERE state = 'PENDING'
          AND plane = $1
          AND (scheduled_for IS NULL OR scheduled_for <= NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY priority DESC, created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED;
      `;
      
      const res = await client.query(claimQuery, [this.#options.plane, batchSize]);
      
      if (res.rows.length > 0) {
        const ids = res.rows.map((r: any) => r.id || r.delivery_id);
        
        await client.query(`
          UPDATE platform.communication_deliveries
             SET state = 'PROCESSING',
                 lease_holder = $1,
                 lease_expires_at = NOW() + INTERVAL '45 seconds',
                 updated_at = NOW()
           WHERE (id = ANY($2::uuid[]) OR delivery_id = ANY($2::uuid[]));
        `, [this.#options.workerId, ids]);

        await client.query('COMMIT');
        
        // Process claimed batch
        for (const row of res.rows as any[]) {
          await this.#processRow(row);
        }
        
        return res.rows as any[];
      }
      
      await client.query('COMMIT');
      return [];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error processing communication queue:', error);
      throw error;
    } finally {
      client.release?.();
    }
  }

  async #processRow(row: any): Promise<void> {
    const deliveryId = row.delivery_id || row.id;
    const tenantId = row.tenant_id;
    let attemptCount = row.attempt_count || 0;

    const payload = await this.#payloadStore.load(tenantId, deliveryId);
    const dispatchResult = await this.#dispatchPort.dispatch(payload);

    const occurredAt = new Date().toISOString();
    const client = await this.#pool.connect();
    
    try {
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
           WHERE tenant_id = $1::uuid AND (delivery_id = $2::uuid OR id = $2::uuid)
        `, [tenantId, deliveryId, toState, dispatchResult.messageId ?? null, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, occurredAt]);

      } else {
        const isRetryable = [
          'PROVIDER_UNAVAILABLE',
          'RATE_LIMITED',
          'THROTTLED'
        ].includes(dispatchResult.reasonCode);
        
        attemptCount++;

        if (isRetryable && attemptCount < this.#maxAttempts) {
          const delayMs = Math.pow(2, attemptCount) * 1000;
          await client.query(`
            UPDATE platform.communication_deliveries
               SET state = 'PENDING',
                   attempt_count = attempt_count + 1,
                   last_reason_code = $3,
                   last_reason = $4,
                   updated_at = NOW() + (interval '1 millisecond' * $5)
             WHERE tenant_id = $1::uuid AND (delivery_id = $2::uuid OR id = $2::uuid)
          `, [tenantId, deliveryId, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, delayMs]);
        } else {
          await client.query(`
            UPDATE platform.communication_deliveries
               SET state = 'FAILED',
                   attempt_count = attempt_count + 1,
                   last_reason_code = $3,
                   last_reason = $4,
                   updated_at = $5
             WHERE tenant_id = $1::uuid AND (delivery_id = $2::uuid OR id = $2::uuid)
          `, [tenantId, deliveryId, dispatchResult.reasonCode, dispatchResult.refusalReason ?? null, occurredAt]);
        }
      }
    } finally {
      client.release?.();
    }
  }
}
