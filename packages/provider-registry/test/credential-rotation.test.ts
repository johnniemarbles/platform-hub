import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialReference,
  CredentialRotationError,
  GovernedCredentialRotationService,
  type ConnectorDefinition,
} from '../src/index.ts';

const current = credentialReference('vault://tenant-1/storage/v1');
const replacement = credentialReference('vault://tenant-1/storage/v2');
const connector: ConnectorDefinition = {
  connectorKey: 'storage-primary',
  providerType: 'OBJECT_STORAGE',
  providerKey: 'neutral-storage',
  ownership: 'TENANT',
  tenantId: 'tenant-1',
  capabilityKeys: ['object.store'],
  credentialRef: current,
  region: 'in',
  residencyTags: ['IN'],
  complianceTags: ['SOC2'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};
const request = {
  requestId: 'rotation-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'security-admin-1',
  connectorKey: 'storage-primary',
  replacementCredentialReference: replacement,
  reason: 'scheduled rotation',
  requestedAt: '2026-08-26T00:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['change://credential/1'],
} as const;

test('authorizes before staging a reference-only rotation', async () => {
  const calls: string[] = [];
  const service = new GovernedCredentialRotationService(
    {
      authorize: async (input) => {
        calls.push('authorize');
        assert.equal(input.currentCredentialReference, current);
        return { decisionId: 'decision-1', allowed: true, reasonKey: 'POLICY_ALLOWED' };
      },
    },
    {
      stage: async (input) => {
        calls.push('stage');
        return {
          rotationReference: 'rotation://1',
          tenantId: input.request.tenantId,
          connectorKey: input.request.connectorKey,
          currentCredentialReference: input.currentCredentialReference,
          replacementCredentialReference: input.request.replacementCredentialReference,
          authorizationDecisionId: input.authorizationDecisionId,
          status: 'STAGED',
          stagedAt: '2026-08-26T00:00:01.000Z',
          auditReference: 'audit://rotation/1',
        };
      },
    },
  );

  const result = await service.stage(request, connector);

  assert.deepEqual(calls, ['authorize', 'stage']);
  assert.equal(result.replacementCredentialReference, replacement);
  assert.equal('secret' in result, false);
});

test('denial prevents the rotation stager', async () => {
  let staged = false;
  const service = new GovernedCredentialRotationService(
    {
      authorize: async () => ({
        decisionId: 'decision-denied',
        allowed: false,
        reasonKey: 'SEPARATION_OF_DUTIES',
      }),
    },
    {
      stage: async () => {
        staged = true;
        throw new Error('must not be called');
      },
    },
  );

  await assert.rejects(
    service.stage(request, connector),
    (error: unknown) => error instanceof CredentialRotationError
      && error.code === 'CREDENTIAL_ROTATION_ACCESS_DENIED',
  );
  assert.equal(staged, false);
});

test('rejects a cross-tenant connector before authorization', async () => {
  let authorized = false;
  const service = new GovernedCredentialRotationService(
    {
      authorize: async () => {
        authorized = true;
        throw new Error('must not be called');
      },
    },
    { stage: async () => { throw new Error('must not be called'); } },
  );

  await assert.rejects(
    service.stage(request, { ...connector, tenantId: 'tenant-2' }),
    (error: unknown) => error instanceof CredentialRotationError
      && error.code === 'CREDENTIAL_ROTATION_CONNECTOR_MISMATCH',
  );
  assert.equal(authorized, false);
});

test('rejects reuse of the active credential reference', async () => {
  const service = new GovernedCredentialRotationService(
    { authorize: async () => { throw new Error('must not be called'); } },
    { stage: async () => { throw new Error('must not be called'); } },
  );

  await assert.rejects(
    service.stage({ ...request, replacementCredentialReference: current }, connector),
    (error: unknown) => error instanceof CredentialRotationError
      && error.code === 'CREDENTIAL_ROTATION_REFERENCE_UNCHANGED',
  );
});
