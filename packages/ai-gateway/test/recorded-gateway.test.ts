import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecordedAiGateway,
  type AiGateway,
  type AiInvocationIntent,
  type AiJobEvent,
  type AiJobRegistration,
  type AiJobRepository,
} from '../src/index.ts';

class Repository implements AiJobRepository {
  registration: AiJobRegistration | null = null;
  readonly events: AiJobEvent[] = [];
  async create(job: AiJobRegistration) {
    if (this.registration) return { status: 'ALREADY_COMMITTED' as const, job: this.registration };
    this.registration = job;
    return { status: 'COMMITTED' as const, job };
  }
  async findById() { return this.registration; }
  async listEvents() { return this.events; }
  async appendEvent(event: AiJobEvent) { this.events.push(event); return { status: 'COMMITTED' as const, event }; }
}

const intent: AiInvocationIntent = {
  invocationId: 'sync-plan-1', tenantId: 'tenant-1', operation: 'GENERATE',
  purpose: 'Plan mission', inputReference: 'artifact://input',
  promptConfiguration: { key: 'mission-plan', version: 1 },
  governance: { requiredResidencyTags: [], requiredComplianceTags: [], maximumCostMinorUnits: 10 },
  idempotencyKey: 'mission-plan-1', requestedAt: '2026-09-13T16:00:00.000Z',
};

test('records registration and terminal success around synchronous provider invocation', async () => {
  const repository = new Repository();
  const gateway: AiGateway = { async invoke(value) { return {
    invocationId: value.invocationId, tenantId: value.tenantId, status: 'OBSERVATION',
    outputReference: 'artifact://output', outputContent: { mediaType: 'application/json', value: '{}' },
    provenance: { connectorKey: 'connector', providerKey: 'openai', modelKey: 'model',
      promptConfigurationKey: value.promptConfiguration.key,
      promptConfigurationVersion: value.promptConfiguration.version,
      sourceReferences: [value.inputReference], processedAt: '2026-09-13T16:00:01.000Z', costMinorUnits: 2 },
  }; } };
  const recorded = new RecordedAiGateway({ gateway, repository, actorSubjectId: 'user-1', now: () => '2026-09-13T16:00:00.000Z' });
  const result = await recorded.invoke(intent);
  assert.equal(result.outputReference, 'artifact://output');
  assert.equal(repository.registration?.maximumAttempts, 1);
  assert.deepEqual(repository.events.map((event) => event.type), ['STARTED', 'SUCCEEDED']);
  assert.equal(repository.events[1]?.type === 'SUCCEEDED' ? repository.events[1].costMinorUnits : null, 2);
});

test('records only a normalized failure and rejects replay without another provider call', async () => {
  const repository = new Repository();
  let calls = 0;
  const gateway: AiGateway = { async invoke() { calls += 1; throw new Error('SENSITIVE upstream body'); } };
  const recorded = new RecordedAiGateway({ gateway, repository, actorSubjectId: 'user-1' });
  await assert.rejects(() => recorded.invoke(intent), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /SENSITIVE/);
    return true;
  });
  assert.equal(repository.events[1]?.type, 'FAILED');
  assert.doesNotMatch(repository.events[1]?.reason ?? '', /SENSITIVE/);
  await assert.rejects(() => recorded.invoke(intent), /REPLAY_REQUIRES_DURABLE_OUTPUT/);
  assert.equal(calls, 1);
});
