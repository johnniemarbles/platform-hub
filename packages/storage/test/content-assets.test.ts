import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContentAssetValidationError,
  assertContentAssetTransition,
  contentAssetObjectReference,
  validateContentAssetRegistration,
} from '../src/content-assets.ts';

const tenantId = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const organizationId = 'c56a4180-65aa-42ec-a945-5fd21dec0539';
const assetId = 'c56a4180-65aa-42ec-a945-5fd21dec0540';

const valid = () => ({
  tenantId,
  organizationId,
  requestedBySubjectId: 'user_123',
  purpose: 'LEARNING_CONTENT',
  filename: 'privacy-guide.pdf',
  contentType: 'application/pdf',
  byteLength: 1024,
  sha256: 'a'.repeat(64),
  idempotencyKey: 'upload:privacy-guide:v1',
  retentionPolicy: { key: 'learning.standard', version: 1 },
  requiredResidencyTags: ['CA'],
  requiredComplianceTags: ['PIPEDA'],
  correlationId: 'course-version:123',
});

test('validates content asset registration without accepting storage credentials', () => {
  const result = validateContentAssetRegistration(valid());
  assert.equal(result.filename, 'privacy-guide.pdf');
  assert.equal(result.contentType, 'application/pdf');
  assert.deepEqual(result.requiredResidencyTags, ['ca']);
  assert.equal('providerKey' in result, false);
  assert.equal('bucket' in result, false);
  assert.equal('publicUrl' in result, false);
});

test('rejects body-chosen paths, malformed digests and invalid scope', () => {
  assert.throws(
    () => validateContentAssetRegistration({ ...valid(), filename: '../secret.pdf' }),
    (error: unknown) => error instanceof ContentAssetValidationError
      && error.code === 'UNSAFE_FILENAME',
  );
  assert.throws(
    () => validateContentAssetRegistration({ ...valid(), sha256: 'short' }),
    (error: unknown) => error instanceof ContentAssetValidationError
      && error.code === 'INVALID_SHA256',
  );
  assert.throws(
    () => validateContentAssetRegistration({ ...valid(), organizationId: 'selected-by-client' }),
    (error: unknown) => error instanceof ContentAssetValidationError
      && error.code === 'INVALID_UUID',
  );
});

test('requires bounded byte length and governed retention/residency', () => {
  assert.throws(() => validateContentAssetRegistration({ ...valid(), byteLength: 0 }), /supported range/);
  assert.throws(
    () => validateContentAssetRegistration({ ...valid(), requiredResidencyTags: [] }),
    /must not be empty/,
  );
  assert.throws(
    () => validateContentAssetRegistration({ ...valid(), retentionPolicy: { key: 'Bad Policy', version: 0 } }),
    /Invalid retention policy key/,
  );
});

test('content asset state machine prevents unsafe availability and resurrection', () => {
  assert.doesNotThrow(() => assertContentAssetTransition('PENDING_UPLOAD', 'UPLOADED'));
  assert.doesNotThrow(() => assertContentAssetTransition('UPLOADED', 'QUARANTINED'));
  assert.doesNotThrow(() => assertContentAssetTransition('QUARANTINED', 'AVAILABLE'));
  assert.doesNotThrow(() => assertContentAssetTransition('AVAILABLE', 'DELETED'));
  assert.throws(() => assertContentAssetTransition('PENDING_UPLOAD', 'AVAILABLE'), /cannot transition/);
  assert.throws(() => assertContentAssetTransition('DELETED', 'AVAILABLE'), /cannot transition/);
  assert.throws(() => assertContentAssetTransition('REJECTED', 'AVAILABLE'), /cannot transition/);
});

test('object references are opaque, deterministic and scope-bound', () => {
  assert.equal(
    contentAssetObjectReference({ tenantId, organizationId, assetId }),
    `content-assets/${tenantId}/${organizationId}/${assetId}`,
  );
});


test('uploaded assets cannot bypass quarantine to become available', () => {
  assert.throws(
    () => assertContentAssetTransition('UPLOADED', 'AVAILABLE'),
    (error: unknown) => error instanceof ContentAssetValidationError
      && error.code === 'INVALID_STATE_TRANSITION',
  );
  assert.doesNotThrow(() => assertContentAssetTransition('UPLOADED', 'QUARANTINED'));
  assert.doesNotThrow(() => assertContentAssetTransition('QUARANTINED', 'AVAILABLE'));
});
