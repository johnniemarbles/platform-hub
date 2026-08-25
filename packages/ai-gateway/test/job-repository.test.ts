import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiJobRegistrationError,
  initialAiJobSnapshot,
  replayAiJob,
  type AiJobEvent,
  type AiJobRegistration,
} from '../src/index.ts';

const registration: AiJobRegistration = {
  jobId: 'job-1',
  intent: {
    invocationId: 'invocation-1',
    tenantId: 'tenant-1',
    operation: 'EXTRACT',
    purpose: 'Extract facts for review.',
    inputReference: 'object://tenant-1/document-1',
    promptConfiguration: { key: 'extract-facts', version: 1 },
    governance: {
      requiredResidencyTags: ['eu'],
      requiredComplianceTags: ['regulated'],
      maximumCostMinorUnits: 20,
    },
    idempotencyKey: 'extract:document-1:v1',
    requestedAt: '2026-08-25T15:00:00.000Z',
  },
  maximumAttempts: 2,
  createdBySubjectId: 'workflow-1',
  createdAt: '2026-08-25T15:00:00.000Z',
  reason: 'Queue AI extraction.',
  correlationId: 'correlation-1',
  evidenceRefs: ['workflow:event-1'],
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
    jobId: registration.jobId,
    tenantId: registration.intent.tenantId,
    sequence,
    occurredAt: `2026-08-25T15:00:0${sequence}.000Z`,
    actorSubjectId: 'worker-1',
    reason: 'Advance AI job.',
    correlationId: registration.correlationId,
    evidenceRefs: ['queue:message-1'],
    ...value,
  };
}

test('creates the initial queued snapshot from an immutable registration', () => {
  assert.deepEqual(initialAiJobSnapshot(registration), {
    jobId: 'job-1',
    tenantId: 'tenant-1',
    invocationId: 'invocation-1',
    status: 'QUEUED',
    attempt: 0,
    maximumAttempts: 2,
    eventSequence: 0,
    createdAt: '2026-08-25T15:00:00.000Z',
    updatedAt: '2026-08-25T15:00:00.000Z',
  });
});

test('deterministically replays append-only events into a snapshot', () => {
  const result = replayAiJob(registration, [
    event(1, { type: 'STARTED' }),
    event(2, {
      type: 'SUCCEEDED',
      outputReference: 'object://tenant-1/output-1',
      confidence: 0.85,
      costMinorUnits: 8,
    }),
  ]);

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.eventSequence, 2);
  assert.equal(result.outputReference, 'object://tenant-1/output-1');
});

test('rejects invalid registration metadata before persistence', () => {
  assert.throws(
    () => initialAiJobSnapshot({
      ...registration,
      maximumAttempts: 0,
    }),
    (error: unknown) =>
      error instanceof AiJobRegistrationError
      && error.code === 'AI_JOB_MAXIMUM_ATTEMPTS_INVALID',
  );
});
