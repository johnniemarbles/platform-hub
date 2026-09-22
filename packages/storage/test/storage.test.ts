import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateObjectStorageIntent,
  validateObjectStorageObservation,
  type ObjectStorageIntent,
  type ObjectStorageObservation,
} from '../src/index.ts';

const digest =
  '0123456789abcdef0123456789abcdef'
  + '0123456789abcdef0123456789abcdef';

const intent: ObjectStorageIntent = {
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'subject-1',
  operation: 'STORE',
  purpose: 'Persist an approved source document.',
  objectReference: 'object://tenant-1/document-1',
  sourceReference: 'upload://staging/document-1',
  expectedSha256: digest,
  contentType: 'application/pdf',
  retentionPolicy: { key: 'business-document', version: 3 },
  requiredResidencyTags: ['ca'],
  requiredComplianceTags: ['regulated'],
  deletionAuthorizationDecisionId: null,
  idempotencyKey: 'store:document-1:v1',
  requestedAt: '2026-08-25T23:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['approval://document-1'],
};

function observation(): ObjectStorageObservation {
  return {
    requestId: intent.requestId,
    tenantId: intent.tenantId,
    operation: intent.operation,
    objectReference: intent.objectReference,
    status: 'STORED',
    contentReference: 'storage://tenant-1/document-1/v1',
    sha256: digest,
    connectorKey: 'tenant-storage',
    providerKey: 'customer-object-storage',
    region: 'ca-central-1',
    completedAt: '2026-08-25T23:00:01.000Z',
    sourceReferences: [intent.sourceReference!],
  };
}

test('accepts governed reference-only storage intent and provenance', () => {
  assert.deepEqual(
    validateObjectStorageIntent(intent),
    { valid: true, issues: [] },
  );
  assert.deepEqual(
    validateObjectStorageObservation(intent, observation()),
    { valid: true, issues: [] },
  );
  assert.equal('credential' in intent, false);
});

test('requires source and digest for storage', () => {
  const result = validateObjectStorageIntent({
    ...intent,
    sourceReference: null,
    expectedSha256: null,
  });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['STORAGE_SOURCE_REQUIRED', 'STORAGE_DIGEST_REQUIRED'],
    );
  }
});

test('requires explicit authorization for deletion', () => {
  const result = validateObjectStorageIntent({
    ...intent,
    operation: 'DELETE',
    sourceReference: null,
    expectedSha256: null,
    contentType: null,
  });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.deepEqual(result.issues, [{
      code: 'STORAGE_DELETE_AUTHORIZATION_REQUIRED',
      path: 'deletionAuthorizationDecisionId',
    }]);
  }
});

test('rejects cross-tenant output or digest substitution', () => {
  const result = validateObjectStorageObservation(intent, {
    ...observation(),
    tenantId: 'tenant-2',
    sha256:
      'abcdef0123456789abcdef0123456789'
      + 'abcdef0123456789abcdef0123456789',
  });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      [
        'STORAGE_OBSERVATION_IDENTITY_MISMATCH',
        'STORAGE_OBSERVATION_INVALID',
      ],
    );
  }
});

test('deletion observations cannot retain content references', () => {
  const deleteIntent: ObjectStorageIntent = {
    ...intent,
    operation: 'DELETE',
    sourceReference: null,
    expectedSha256: null,
    contentType: null,
    deletionAuthorizationDecisionId: 'decision-1',
  };
  const result = validateObjectStorageObservation(deleteIntent, {
    ...observation(),
    operation: 'DELETE',
    status: 'DELETED',
  });
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(
      result.issues[0]?.code,
      'STORAGE_OBSERVATION_INVALID',
    );
  }
});
