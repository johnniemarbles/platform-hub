import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuditedObjectStorageGateway,
  type ObjectStorageIntent,
  type ObjectStorageObservation,
  type ObjectStorageOperationRecord,
} from '../src/index.ts';

const digest =
  '0123456789abcdef0123456789abcdef'
  + '0123456789abcdef0123456789abcdef';

const intent: ObjectStorageIntent = {
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'subject-1',
  operation: 'STORE',
  purpose: 'Persist approved document.',
  objectReference: 'object://document-1',
  sourceReference: 'upload://document-1',
  expectedSha256: digest,
  contentType: 'application/pdf',
  retentionPolicy: { key: 'documents', version: 3 },
  requiredResidencyTags: ['ca'],
  requiredComplianceTags: ['regulated'],
  deletionAuthorizationDecisionId: null,
  idempotencyKey: 'store:document-1',
  requestedAt: '2026-08-26T00:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['approval://document-1'],
};

const observation: ObjectStorageObservation = {
  requestId: intent.requestId,
  tenantId: intent.tenantId,
  operation: intent.operation,
  objectReference: intent.objectReference,
  status: 'STORED',
  contentReference: 'storage://document-1/v1',
  sha256: digest,
  connectorKey: 'tenant-storage',
  providerKey: 'customer-storage',
  region: 'ca-central-1',
  completedAt: '2026-08-26T00:00:01.000Z',
  sourceReferences: ['upload://document-1'],
};

test('returns provider success only after the audit record commits', async () => {
  const events: string[] = [];
  const records: ObjectStorageOperationRecord[] = [];
  const gateway = new AuditedObjectStorageGateway({
    gateway: {
      async execute() {
        events.push('provider');
        return observation;
      },
    },
    repository: {
      async record(record) {
        events.push('audit');
        records.push(record);
        return { recorded: true, operation: record };
      },
      async findByRequest() {
        return undefined;
      },
    },
    operationId: () =>
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });

  const result = await gateway.execute(intent);

  assert.deepEqual(events, ['provider', 'audit']);
  assert.equal(result, observation);
  assert.equal(records[0]?.intent, intent);
  assert.equal(records[0]?.observation, observation);
});

test('propagates audit failures instead of returning unaudited success', async () => {
  const gateway = new AuditedObjectStorageGateway({
    gateway: {
      async execute() {
        return observation;
      },
    },
    repository: {
      async record() {
        throw new Error('AUDIT_UNAVAILABLE');
      },
      async findByRequest() {
        return undefined;
      },
    },
    operationId: () =>
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });

  await assert.rejects(
    () => gateway.execute(intent),
    /AUDIT_UNAVAILABLE/,
  );
});

test('rejects a missing durable operation identity before recording', async () => {
  let recordCalls = 0;
  const gateway = new AuditedObjectStorageGateway({
    gateway: {
      async execute() {
        return observation;
      },
    },
    repository: {
      async record(record) {
        recordCalls += 1;
        return { recorded: true, operation: record };
      },
      async findByRequest() {
        return undefined;
      },
    },
    operationId: () => ' ',
  });

  await assert.rejects(
    () => gateway.execute(intent),
    /STORAGE_OPERATION_ID_REQUIRED/,
  );
  assert.equal(recordCalls, 0);
});
