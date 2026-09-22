import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiJobTransitionError,
  applyAiJobEvent,
  type AiJobEvent,
  type AiJobSnapshot,
} from '../src/index.ts';

const queued: AiJobSnapshot = {
  jobId: 'job-1',
  tenantId: 'tenant-1',
  invocationId: 'invocation-1',
  status: 'QUEUED',
  attempt: 0,
  maximumAttempts: 2,
  eventSequence: 0,
  createdAt: '2026-08-25T15:00:00.000Z',
  updatedAt: '2026-08-25T15:00:00.000Z',
};

type EventPayload =
  | { readonly type: 'STARTED' }
  | {
      readonly type: 'SUCCEEDED';
      readonly outputReference: string;
      readonly confidence?: number;
      readonly costMinorUnits?: number;
    }
  | { readonly type: 'FAILED'; readonly failureCode: string }
  | { readonly type: 'RETRY_SCHEDULED'; readonly nextAttemptAt: string }
  | { readonly type: 'CANCELLED' };

function event(sequence: number, value: EventPayload): AiJobEvent {
  return {
    eventId: `event-${sequence}`,
    jobId: 'job-1',
    tenantId: 'tenant-1',
    sequence,
    occurredAt: `2026-08-25T15:00:0${sequence}.000Z`,
    actorSubjectId: 'ai-worker',
    reason: 'Advance durable AI job.',
    correlationId: 'correlation-1',
    evidenceRefs: ['queue:message-1'],
    ...value,
  };
}

test('applies a successful job lifecycle as immutable snapshots', () => {
  const running = applyAiJobEvent(queued, event(1, { type: 'STARTED' }));
  const succeeded = applyAiJobEvent(running, event(2, {
    type: 'SUCCEEDED',
    outputReference: 'object://tenant-1/output-1',
    confidence: 0.8,
    costMinorUnits: 5,
  }));

  assert.equal(queued.status, 'QUEUED');
  assert.equal(running.status, 'RUNNING');
  assert.equal(running.attempt, 1);
  assert.equal(succeeded.status, 'SUCCEEDED');
  assert.equal(succeeded.eventSequence, 2);
  assert.equal(succeeded.outputReference, 'object://tenant-1/output-1');
});

test('permits a controlled retry while attempts remain', () => {
  const running = applyAiJobEvent(queued, event(1, { type: 'STARTED' }));
  const failed = applyAiJobEvent(running, event(2, {
    type: 'FAILED',
    failureCode: 'PROVIDER_TIMEOUT',
  }));
  const retry = applyAiJobEvent(failed, event(3, {
    type: 'RETRY_SCHEDULED',
    nextAttemptAt: '2026-08-25T15:05:00.000Z',
  }));

  assert.equal(retry.status, 'QUEUED');
  assert.equal(retry.attempt, 1);
  assert.equal(retry.lastFailureCode, 'PROVIDER_TIMEOUT');
});

test('rejects cross-tenant and replayed events', () => {
  assert.throws(
    () => applyAiJobEvent(queued, {
      ...event(1, { type: 'STARTED' }),
      tenantId: 'tenant-2',
    }),
    (error: unknown) =>
      error instanceof AiJobTransitionError
      && error.code === 'AI_JOB_IDENTITY_MISMATCH',
  );

  assert.throws(
    () => applyAiJobEvent({ ...queued, eventSequence: 1 }, event(1, {
      type: 'STARTED',
    })),
    (error: unknown) =>
      error instanceof AiJobTransitionError
      && error.code === 'AI_JOB_SEQUENCE_INVALID',
  );
});

test('rejects exhausted retries and terminal-state transitions', () => {
  const failed: AiJobSnapshot = {
    ...queued,
    status: 'FAILED',
    attempt: 2,
    maximumAttempts: 2,
    eventSequence: 2,
  };
  assert.throws(
    () => applyAiJobEvent(failed, event(3, {
      type: 'RETRY_SCHEDULED',
      nextAttemptAt: '2026-08-25T15:05:00.000Z',
    })),
    (error: unknown) =>
      error instanceof AiJobTransitionError
      && error.code === 'AI_JOB_ATTEMPTS_EXHAUSTED',
  );

  assert.throws(
    () => applyAiJobEvent({
      ...failed,
      status: 'SUCCEEDED',
    }, event(3, { type: 'CANCELLED' })),
    (error: unknown) =>
      error instanceof AiJobTransitionError
      && error.code === 'AI_JOB_TRANSITION_INVALID',
  );
});
