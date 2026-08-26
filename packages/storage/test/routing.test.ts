import assert from 'node:assert/strict';
import test from 'node:test';
import {
  credentialReference,
  type ConnectorDefinition,
} from '@platform-hub/provider-registry';
import {
  RoutedObjectStorageError,
  RoutedObjectStorageGateway,
  storageCapabilityKey,
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
  purpose: 'Persist an approved document.',
  objectReference: 'object://tenant-1/document-1',
  sourceReference: 'upload://document-1',
  expectedSha256: digest,
  contentType: 'application/pdf',
  retentionPolicy: { key: 'documents', version: 2 },
  requiredResidencyTags: ['ca'],
  requiredComplianceTags: ['regulated'],
  deletionAuthorizationDecisionId: null,
  idempotencyKey: 'store:document-1',
  requestedAt: '2026-08-26T00:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['approval://document-1'],
};

const connector: ConnectorDefinition = {
  connectorKey: 'tenant-storage',
  providerType: 'object-storage',
  providerKey: 'customer-storage',
  ownership: 'TENANT',
  tenantId: 'tenant-1',
  capabilityKeys: ['storage.store'],
  credentialRef: credentialReference(
    'secret://tenant-1/object-storage',
  ),
  region: 'ca-central-1',
  residencyTags: ['ca'],
  complianceTags: ['regulated'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};

function observation(): ObjectStorageObservation {
  return {
    requestId: intent.requestId,
    tenantId: intent.tenantId,
    operation: intent.operation,
    objectReference: intent.objectReference,
    status: 'STORED',
    contentReference: 'storage://document-1/v1',
    sha256: digest,
    connectorKey: connector.connectorKey,
    providerKey: connector.providerKey,
    region: connector.region!,
    completedAt: '2026-08-26T00:00:01.000Z',
    sourceReferences: [intent.sourceReference!],
  };
}

test('maps operations to provider-registry capabilities', () => {
  assert.equal(storageCapabilityKey('DELETE'), 'storage.delete');
});

test('routes through a compliant credential-referenced adapter', async () => {
  const invoked: string[] = [];
  const gateway = new RoutedObjectStorageGateway({
    connectors: [connector],
    adapters: new Map([[
      connector.connectorKey,
      {
        async execute(input) {
          invoked.push(input.connector.credentialRef!);
          return observation();
        },
      },
    ]]),
  });

  const result = await gateway.execute(intent);

  assert.equal(result.connectorKey, 'tenant-storage');
  assert.deepEqual(invoked, [
    'secret://tenant-1/object-storage',
  ]);
});

test('fails before invocation without a managed credential reference', async () => {
  let invoked = false;
  const {
    credentialRef: omittedCredential,
    ...connectorWithoutCredential
  } = connector;
  void omittedCredential;
  const gateway = new RoutedObjectStorageGateway({
    connectors: [connectorWithoutCredential],
    adapters: new Map([[
      connector.connectorKey,
      {
        async execute() {
          invoked = true;
          return observation();
        },
      },
    ]]),
  });

  await assert.rejects(
    () => gateway.execute(intent),
    (error: unknown) =>
      error instanceof RoutedObjectStorageError
      && error.code === 'STORAGE_CREDENTIAL_REFERENCE_REQUIRED',
  );
  assert.equal(invoked, false);
});

test('fails closed when residency cannot be satisfied', async () => {
  const gateway = new RoutedObjectStorageGateway({
    connectors: [{ ...connector, residencyTags: ['us'] }],
    adapters: new Map(),
  });

  await assert.rejects(
    () => gateway.execute(intent),
    (error: unknown) =>
      error instanceof RoutedObjectStorageError
      && error.code === 'STORAGE_CONNECTOR_UNAVAILABLE',
  );
});

test('rejects provenance from a connector other than the selected route', async () => {
  const gateway = new RoutedObjectStorageGateway({
    connectors: [connector],
    adapters: new Map([[
      connector.connectorKey,
      {
        async execute() {
          return {
            ...observation(),
            connectorKey: 'unselected-storage',
          };
        },
      },
    ]]),
  });

  await assert.rejects(
    () => gateway.execute(intent),
    (error: unknown) =>
      error instanceof RoutedObjectStorageError
      && error.code === 'STORAGE_CONNECTOR_PROVENANCE_MISMATCH',
  );
});
