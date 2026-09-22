import { createHash, randomUUID } from 'node:crypto';
import type { AiGateway, AiInvocationIntent, AiProposal } from './index.ts';
import type { AiJobEvent, AiJobSnapshot } from './jobs.ts';
import { replayAiJob } from './job-repository.ts';
import type { AiJobRegistration, AiJobRepository } from './job-repository.ts';
import { safeAiFailure } from './provider-errors.ts';

export interface AiQuotaCheckResult {
  readonly allowed: boolean;
  readonly operation: AiInvocationIntent['operation'] | null;
  readonly period: 'DAILY' | 'MONTHLY';
  readonly limitCostMinorUnits: number;
  readonly currentSpendMinorUnits: number;
  readonly requestedCostMinorUnits?: number;
  readonly reservedCostMinorUnits?: number;
  readonly projectedSpendMinorUnits?: number;
  readonly reasonKey?: 'AI_QUOTA_EXCEEDED' | 'AI_COST_CEILING_REQUIRED';
}

/**
 * Checked once per invocation, before the underlying gateway (and therefore
 * before any provider is ever called) -- a rolling tenant spend ceiling, not
 * the per-job maximumCostMinorUnits ceiling AiJobRepository already enforces
 * after the fact. Returning null means no quota is configured for this
 * tenant/operation, which is the default, unlimited state.
 */
export interface AiQuotaEnforcer {
  check(input: {
    readonly tenantId: string;
    readonly operation: AiInvocationIntent['operation'];
    readonly jobId: string;
    readonly maximumCostMinorUnits?: number;
  }): Promise<AiQuotaCheckResult | null>;
  reconcile?(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly actualCostMinorUnits: number;
  }): Promise<void>;
}

export class AiQuotaExceededError extends Error {
  readonly code: 'AI_QUOTA_EXCEEDED' | 'AI_COST_CEILING_REQUIRED';
  readonly result: AiQuotaCheckResult;

  constructor(result: AiQuotaCheckResult) {
    super(result.reasonKey === 'AI_COST_CEILING_REQUIRED'
      ? 'AI_COST_CEILING_REQUIRED: a maximum cost is required while a tenant AI quota is active.'
      : `AI_QUOTA_EXCEEDED: request would exceed the tenant's ${result.period.toLowerCase()} AI spend limit.`);
    this.name = 'AiQuotaExceededError';
    this.code = result.reasonKey ?? 'AI_QUOTA_EXCEEDED';
    this.result = result;
  }
}

export interface RecordedAiGatewayOptions {
  readonly gateway: AiGateway;
  readonly repository: AiJobRepository;
  readonly actorSubjectId: string;
  readonly now?: () => string;
  readonly quotaEnforcer?: AiQuotaEnforcer;
  readonly recordUsage?: (intent: AiInvocationIntent, proposal: AiProposal) => Promise<void>;
}

/**
 * Immutable admission and terminal history for synchronous AI consumers.
 * Replays fail closed because successful provider content is intentionally not
 * stored in job history; callers must use the asynchronous artifact worker
 * when replayable output content is required.
 */
export class RecordedAiGateway implements AiGateway {
  readonly #gateway: AiGateway;
  readonly #repository: AiJobRepository;
  readonly #actorSubjectId: string;
  readonly #now: () => string;
  readonly #quotaEnforcer: AiQuotaEnforcer | undefined;
  readonly #recordUsage: RecordedAiGatewayOptions['recordUsage'];

  constructor(options: RecordedAiGatewayOptions) {
    if (options.actorSubjectId.trim() === '') throw new Error('AI_RECORDED_GATEWAY_ACTOR_REQUIRED');
    this.#gateway = options.gateway;
    this.#repository = options.repository;
    this.#actorSubjectId = options.actorSubjectId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#quotaEnforcer = options.quotaEnforcer;
    this.#recordUsage = options.recordUsage;
  }

  async invoke(intent: AiInvocationIntent): Promise<AiProposal> {
    const jobId = uuidFromSeed(`ai-job:${intent.tenantId}:${intent.idempotencyKey}`);
    const correlationId = uuidFromSeed(`ai-correlation:${intent.tenantId}:${intent.invocationId}`);
    // Registration fields must be stable so a replay resolves the same
    // idempotency identity instead of conflicting on wall-clock time.
    const createdAt = intent.requestedAt;
    const registration: AiJobRegistration = {
      jobId, intent, maximumAttempts: 1,
      createdBySubjectId: this.#actorSubjectId, createdAt,
      reason: 'Record synchronous governed AI invocation.', correlationId,
      evidenceRefs: [intent.inputReference, ...(intent.contextReference ? [intent.contextReference] : [])],
    };
    const created = await this.#repository.create(registration);
    if (created.status === 'IDEMPOTENCY_CONFLICT') {
      throw new Error('AI_SYNC_INVOCATION_IDEMPOTENCY_CONFLICT');
    }

    const priorEvents = await this.#repository.listEvents({ tenantId: intent.tenantId, jobId });
    if (priorEvents.length > 0) {
      const snapshot = replayAiJob(created.job, priorEvents);
      throw replayError(snapshot);
    }

    await append(this.#repository, eventBase(registration, 1, 'STARTED', this.#now()));

    const quota = await this.#quotaEnforcer?.check({
      tenantId: intent.tenantId,
      operation: intent.operation,
      jobId,
      ...(intent.governance.maximumCostMinorUnits === undefined
        ? {}
        : { maximumCostMinorUnits: intent.governance.maximumCostMinorUnits }),
    });
    if (quota !== undefined && quota !== null && !quota.allowed) {
      const quotaError = new AiQuotaExceededError(quota);
      await append(this.#repository, {
        ...eventBase(registration, 2, 'FAILED', this.#now()),
        type: 'FAILED', failureCode: quotaError.code,
        reason: quotaError.message,
      });
      throw quotaError;
    }

    try {
      const proposal = await this.#gateway.invoke(intent);
      if (quota !== undefined && quota !== null && proposal.provenance.costMinorUnits === undefined) {
        throw new Error('AI_COST_EVIDENCE_REQUIRED');
      }
      if (quota !== undefined && quota !== null && proposal.provenance.costMinorUnits !== undefined) {
        await this.#quotaEnforcer?.reconcile?.({
          tenantId: intent.tenantId,
          jobId,
          actualCostMinorUnits: proposal.provenance.costMinorUnits,
        });
      }
      await this.#recordUsage?.(intent, proposal);
      await append(this.#repository, {
        ...eventBase(registration, 2, 'SUCCEEDED', this.#now()),
        type: 'SUCCEEDED', outputReference: proposal.outputReference,
        ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
        ...(proposal.provenance.costMinorUnits === undefined ? {} : { costMinorUnits: proposal.provenance.costMinorUnits }),
      });
      return proposal;
    } catch (error) {
      console.error('[RecordedAiGateway] Original error from gateway invoke:', error);
      const actualCost = actualCostFromFailure(error);
      if (quota !== undefined && quota !== null && actualCost !== undefined) {
        await this.#quotaEnforcer?.reconcile?.({
          tenantId: intent.tenantId,
          jobId,
          actualCostMinorUnits: actualCost,
        });
      }
      const failure = safeAiFailure(error);
      await append(this.#repository, {
        ...eventBase(registration, 2, 'FAILED', this.#now()),
        type: 'FAILED', failureCode: failure.code,
        reason: failure.reason,
      });
      throw new Error(failure.reason);
    }
  }
}

function actualCostFromFailure(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('actualCostMinorUnits' in error)) return undefined;
  const value = (error as { actualCostMinorUnits?: unknown }).actualCostMinorUnits;
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
    ? value
    : undefined;
}

function eventBase(
  job: AiJobRegistration,
  sequence: number,
  type: 'STARTED' | 'SUCCEEDED' | 'FAILED',
  occurredAt: string,
): AiJobEvent {
  const common = {
    eventId: randomUUID(), jobId: job.jobId, tenantId: job.intent.tenantId,
    sequence, occurredAt, actorSubjectId: job.createdBySubjectId,
    reason: type === 'STARTED' ? 'Synchronous AI invocation admitted.' : 'Synchronous AI invocation completed.',
    correlationId: job.correlationId, evidenceRefs: job.evidenceRefs,
  };
  if (type === 'FAILED') return { ...common, type, failureCode: 'AI_EXECUTION_FAILED' };
  if (type === 'SUCCEEDED') return { ...common, type, outputReference: 'pending://provider-output' };
  return { ...common, type };
}

async function append(repository: AiJobRepository, event: AiJobEvent): Promise<void> {
  const result = await repository.appendEvent(event);
  if (result.status !== 'COMMITTED' && result.status !== 'ALREADY_COMMITTED') {
    throw new Error(`AI_SYNC_EVENT_SEQUENCE_CONFLICT:${result.expectedSequence}`);
  }
}

function replayError(snapshot: AiJobSnapshot): Error {
  return new Error(snapshot.status === 'RUNNING'
    ? 'AI_SYNC_INVOCATION_ALREADY_RUNNING'
    : 'AI_SYNC_INVOCATION_REPLAY_REQUIRES_DURABLE_OUTPUT');
}

function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
