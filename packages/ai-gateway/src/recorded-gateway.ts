import { createHash, randomUUID } from 'node:crypto';
import type { AiGateway, AiInvocationIntent, AiProposal } from './index.ts';
import type { AiJobEvent, AiJobSnapshot } from './jobs.ts';
import { replayAiJob } from './job-repository.ts';
import type { AiJobRegistration, AiJobRepository } from './job-repository.ts';
import { safeAiFailure } from './provider-errors.ts';

export interface RecordedAiGatewayOptions {
  readonly gateway: AiGateway;
  readonly repository: AiJobRepository;
  readonly actorSubjectId: string;
  readonly now?: () => string;
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

  constructor(options: RecordedAiGatewayOptions) {
    if (options.actorSubjectId.trim() === '') throw new Error('AI_RECORDED_GATEWAY_ACTOR_REQUIRED');
    this.#gateway = options.gateway;
    this.#repository = options.repository;
    this.#actorSubjectId = options.actorSubjectId;
    this.#now = options.now ?? (() => new Date().toISOString());
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
    try {
      const proposal = await this.#gateway.invoke(intent);
      await append(this.#repository, {
        ...eventBase(registration, 2, 'SUCCEEDED', this.#now()),
        type: 'SUCCEEDED', outputReference: proposal.outputReference,
        ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
        ...(proposal.provenance.costMinorUnits === undefined ? {} : { costMinorUnits: proposal.provenance.costMinorUnits }),
      });
      return proposal;
    } catch (error) {
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
