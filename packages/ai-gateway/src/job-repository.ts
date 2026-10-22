import type {
  AiInvocationIntent,
  AiJobEvent,
  AiJobSnapshot,
} from './index.ts';
import { applyAiJobEvent, validateAiInvocationIntent } from './index.ts';

export interface AiJobRegistration {
  readonly jobId: string;
  readonly intent: AiInvocationIntent;
  readonly maximumAttempts: number;
  readonly createdBySubjectId: string;
  readonly createdAt: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export type AiJobCreateResult =
  | { readonly status: 'COMMITTED'; readonly job: AiJobRegistration }
  | { readonly status: 'ALREADY_COMMITTED'; readonly job: AiJobRegistration }
  | {
      readonly status: 'IDEMPOTENCY_CONFLICT';
      readonly existing: AiJobRegistration;
    };

export type AiJobEventAppendResult =
  | { readonly status: 'COMMITTED'; readonly event: AiJobEvent }
  | { readonly status: 'ALREADY_COMMITTED'; readonly event: AiJobEvent }
  | {
      readonly status: 'SEQUENCE_CONFLICT';
      readonly expectedSequence: number;
    };

export interface AiJobRepository {
  create(job: AiJobRegistration): Promise<AiJobCreateResult>;
  findById(input: {
    readonly tenantId: string;
    readonly jobId: string;
  }): Promise<AiJobRegistration | null>;
  listEvents(input: {
    readonly tenantId: string;
    readonly jobId: string;
  }): Promise<readonly AiJobEvent[]>;
  appendEvent(event: AiJobEvent): Promise<AiJobEventAppendResult>;
}

export type AiJobRegistrationErrorCode =
  | 'AI_JOB_ID_REQUIRED'
  | 'AI_JOB_MAXIMUM_ATTEMPTS_INVALID'
  | 'AI_JOB_CREATOR_REQUIRED'
  | 'AI_JOB_CREATED_AT_INVALID'
  | 'AI_JOB_REASON_REQUIRED'
  | 'AI_JOB_CORRELATION_REQUIRED'
  | 'AI_JOB_EVIDENCE_REQUIRED'
  | 'AI_JOB_INTENT_INVALID';

export class AiJobRegistrationError extends Error {
  readonly code: AiJobRegistrationErrorCode;

  constructor(code: AiJobRegistrationErrorCode, message: string) {
    super(message);
    this.name = 'AiJobRegistrationError';
    this.code = code;
  }
}

export function initialAiJobSnapshot(
  registration: AiJobRegistration,
): AiJobSnapshot {
  validateRegistration(registration);
  return {
    jobId: registration.jobId,
    tenantId: registration.intent.tenantId,
    invocationId: registration.intent.invocationId,
    status: 'QUEUED',
    attempt: 0,
    maximumAttempts: registration.maximumAttempts,
    eventSequence: 0,
    createdAt: registration.createdAt,
    updatedAt: registration.createdAt,
  };
}

export function replayAiJob(
  registration: AiJobRegistration,
  events: readonly AiJobEvent[],
): AiJobSnapshot {
  return events.reduce(
    (snapshot, event) => applyAiJobEvent(snapshot, event),
    initialAiJobSnapshot(registration),
  );
}

function validateRegistration(registration: AiJobRegistration): void {
  if (registration.jobId.trim() === '') {
    throw new AiJobRegistrationError(
      'AI_JOB_ID_REQUIRED',
      'jobId is required.',
    );
  }
  if (
    !Number.isInteger(registration.maximumAttempts)
    || registration.maximumAttempts <= 0
  ) {
    throw new AiJobRegistrationError(
      'AI_JOB_MAXIMUM_ATTEMPTS_INVALID',
      'maximumAttempts must be a positive integer.',
    );
  }
  if (registration.createdBySubjectId.trim() === '') {
    throw new AiJobRegistrationError(
      'AI_JOB_CREATOR_REQUIRED',
      'createdBySubjectId is required.',
    );
  }
  if (!validInstant(registration.createdAt)) {
    throw new AiJobRegistrationError(
      'AI_JOB_CREATED_AT_INVALID',
      'createdAt must be a valid instant.',
    );
  }
  if (registration.reason.trim() === '') {
    throw new AiJobRegistrationError(
      'AI_JOB_REASON_REQUIRED',
      'reason is required.',
    );
  }
  if (registration.correlationId.trim() === '') {
    throw new AiJobRegistrationError(
      'AI_JOB_CORRELATION_REQUIRED',
      'correlationId is required.',
    );
  }
  if (registration.evidenceRefs.length === 0) {
    throw new AiJobRegistrationError(
      'AI_JOB_EVIDENCE_REQUIRED',
      'At least one evidence reference is required.',
    );
  }
  const intent = validateAiInvocationIntent(registration.intent);
  if (!intent.valid) {
    throw new AiJobRegistrationError(
      'AI_JOB_INTENT_INVALID',
      intent.issues.map((issue) => issue.code).join(','),
    );
  }
}

function validInstant(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value));
}
