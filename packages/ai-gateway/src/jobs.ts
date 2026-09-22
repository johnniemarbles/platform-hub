export type AiJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface AiJobSnapshot {
  readonly jobId: string;
  readonly tenantId: string;
  readonly invocationId: string;
  readonly status: AiJobStatus;
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly eventSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly outputReference?: string;
  readonly confidence?: number;
  readonly costMinorUnits?: number;
  readonly lastFailureCode?: string;
  readonly nextAttemptAt?: string;
}

interface AiJobEventBase {
  readonly eventId: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actorSubjectId: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export type AiJobEvent =
  | (AiJobEventBase & { readonly type: 'STARTED' })
  | (AiJobEventBase & {
      readonly type: 'SUCCEEDED';
      readonly outputReference: string;
      readonly confidence?: number;
      readonly costMinorUnits?: number;
    })
  | (AiJobEventBase & {
      readonly type: 'FAILED';
      readonly failureCode: string;
    })
  | (AiJobEventBase & {
      readonly type: 'RETRY_SCHEDULED';
      readonly nextAttemptAt: string;
    })
  | (AiJobEventBase & { readonly type: 'CANCELLED' });

export type AiJobTransitionErrorCode =
  | 'AI_JOB_IDENTITY_MISMATCH'
  | 'AI_JOB_SEQUENCE_INVALID'
  | 'AI_JOB_EVENT_METADATA_INVALID'
  | 'AI_JOB_TRANSITION_INVALID'
  | 'AI_JOB_ATTEMPTS_EXHAUSTED'
  | 'AI_JOB_OUTPUT_INVALID'
  | 'AI_JOB_FAILURE_INVALID'
  | 'AI_JOB_RETRY_AT_INVALID'
  | 'AI_JOB_CONFIDENCE_INVALID'
  | 'AI_JOB_COST_INVALID';

export class AiJobTransitionError extends Error {
  readonly code: AiJobTransitionErrorCode;

  constructor(code: AiJobTransitionErrorCode, message: string) {
    super(message);
    this.name = 'AiJobTransitionError';
    this.code = code;
  }
}

/**
 * Applies one immutable, strictly sequenced job event. Persistence stores the
 * event as append-only history and may cache the returned snapshot.
 */
export function applyAiJobEvent(
  job: AiJobSnapshot,
  event: AiJobEvent,
): AiJobSnapshot {
  validateEventEnvelope(job, event);
  const common = {
    ...job,
    eventSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case 'STARTED':
      requireStatus(job, event, ['QUEUED']);
      if (job.attempt >= job.maximumAttempts) {
        throw new AiJobTransitionError(
          'AI_JOB_ATTEMPTS_EXHAUSTED',
          'The job has no remaining attempts.',
        );
      }
      return {
        ...common,
        status: 'RUNNING',
        attempt: job.attempt + 1,
      };

    case 'SUCCEEDED':
      requireStatus(job, event, ['RUNNING']);
      if (event.outputReference.trim() === '') {
        throw new AiJobTransitionError(
          'AI_JOB_OUTPUT_INVALID',
          'A successful job requires an output reference.',
        );
      }
      validateConfidence(event.confidence);
      validateCost(event.costMinorUnits);
      return {
        ...common,
        status: 'SUCCEEDED',
        outputReference: event.outputReference,
        ...(event.confidence === undefined
          ? {}
          : { confidence: event.confidence }),
        ...(event.costMinorUnits === undefined
          ? {}
          : { costMinorUnits: event.costMinorUnits }),
      };

    case 'FAILED':
      requireStatus(job, event, ['RUNNING']);
      if (event.failureCode.trim() === '') {
        throw new AiJobTransitionError(
          'AI_JOB_FAILURE_INVALID',
          'A failed job requires a failure code.',
        );
      }
      return {
        ...common,
        status: 'FAILED',
        lastFailureCode: event.failureCode,
      };

    case 'RETRY_SCHEDULED':
      requireStatus(job, event, ['FAILED']);
      if (job.attempt >= job.maximumAttempts) {
        throw new AiJobTransitionError(
          'AI_JOB_ATTEMPTS_EXHAUSTED',
          'The job has no remaining attempts.',
        );
      }
      if (!validInstant(event.nextAttemptAt)) {
        throw new AiJobTransitionError(
          'AI_JOB_RETRY_AT_INVALID',
          'A retry requires a valid next-attempt instant.',
        );
      }
      return {
        ...common,
        status: 'QUEUED',
        nextAttemptAt: event.nextAttemptAt,
      };

    case 'CANCELLED':
      requireStatus(job, event, ['QUEUED', 'RUNNING', 'FAILED']);
      return { ...common, status: 'CANCELLED' };
  }
}

function validateEventEnvelope(
  job: AiJobSnapshot,
  event: AiJobEvent,
): void {
  if (event.jobId !== job.jobId || event.tenantId !== job.tenantId) {
    throw new AiJobTransitionError(
      'AI_JOB_IDENTITY_MISMATCH',
      'Job events must match the job and tenant.',
    );
  }
  if (event.sequence !== job.eventSequence + 1) {
    throw new AiJobTransitionError(
      'AI_JOB_SEQUENCE_INVALID',
      'Job events must be applied exactly once and in sequence.',
    );
  }
  if (
    event.eventId.trim() === ''
    || event.actorSubjectId.trim() === ''
    || event.reason.trim() === ''
    || event.correlationId.trim() === ''
    || event.evidenceRefs.length === 0
    || !validInstant(event.occurredAt)
  ) {
    throw new AiJobTransitionError(
      'AI_JOB_EVENT_METADATA_INVALID',
      'Job events require actor, reason, correlation, evidence, and time.',
    );
  }
}

function requireStatus(
  job: AiJobSnapshot,
  event: AiJobEvent,
  allowed: readonly AiJobStatus[],
): void {
  if (!allowed.includes(job.status)) {
    throw new AiJobTransitionError(
      'AI_JOB_TRANSITION_INVALID',
      `${event.type} cannot follow ${job.status}.`,
    );
  }
}

function validateConfidence(confidence: number | undefined): void {
  if (
    confidence !== undefined
    && (
      !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
    )
  ) {
    throw new AiJobTransitionError(
      'AI_JOB_CONFIDENCE_INVALID',
      'Confidence must be between zero and one.',
    );
  }
}

function validateCost(cost: number | undefined): void {
  if (
    cost !== undefined
    && (!Number.isInteger(cost) || cost < 0)
  ) {
    throw new AiJobTransitionError(
      'AI_JOB_COST_INVALID',
      'Cost must be a non-negative integer.',
    );
  }
}

function validInstant(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value));
}
