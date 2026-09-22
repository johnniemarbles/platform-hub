import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CredentialLeaseError,
  GovernedCredentialLeaseService,
} from '../src/credential-access.ts';
import { credentialReference, type ConnectorDefinition } from '../src/index.ts';

const credentialRef = credentialReference('vault://tenant-1/storage');
const request = {
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'subject-1',
  connectorKey: 'storage-primary',
  purpose: 'object.write',
  requestedAt: '2026-08-26T00:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['evidence://approval/1'],
} as const;
const connector: ConnectorDefinition = {
  connectorKey: 'storage-primary',
  providerType: 'OBJECT_STORAGE',
  providerKey: 'neutral-storage',
  ownership: 'TENANT',
  tenantId: 'tenant-1',
  capabilityKeys: ['object.store'],
  credentialRef,
  region: 'in',
  residencyTags: ['IN'],
  complianceTags: ['SOC2'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};

test('authorizes before issuing a scoped reference-only lease', async () => {
  const calls: string[] = [];
  const service = new GovernedCredentialLeaseService(
    {
      authorize: async (query) => {
        calls.push(`authorize:${query.action}`);
        assert.equal(query.credentialReference, credentialRef);
        return { decisionId: 'decision-1', allowed: true, reasonKey: 'POLICY_ALLOWED' };
      },
    },
    {
      issue: async (input) => {
        calls.push(`issue:${input.maximumLeaseSeconds}`);
        assert.equal(input.credentialReference, credentialRef);
        return {
          leaseReference: 'lease://1',
          tenantId: input.request.tenantId,
          connectorKey: input.request.connectorKey,
          credentialReference: input.credentialReference,
          authorizationDecisionId: input.authorizationDecisionId,
          issuedAt: '2026-08-26T00:00:00.000Z',
          expiresAt: '2026-08-26T00:05:00.000Z',
          auditReference: 'audit://credential-lease/1',
        };
      },
    },
    300,
  );

  const lease = await service.issue(request, connector);

  assert.deepEqual(calls, ['authorize:credential.lease', 'issue:300']);
  assert.equal('secret' in lease, false);
  assert.equal(lease.credentialReference, credentialRef);
});

test('denial prevents credential issuer access', async () => {
  let issuerCalled = false;
  const service = new GovernedCredentialLeaseService(
    {
      authorize: async () => ({
        decisionId: 'decision-denied',
        allowed: false,
        reasonKey: 'SUBJECT_NOT_ALLOWED',
      }),
    },
    {
      issue: async () => {
        issuerCalled = true;
        throw new Error('must not be called');
      },
    },
    300,
  );

  await assert.rejects(
    service.issue(request, connector),
    (error: unknown) => error instanceof CredentialLeaseError &&
      error.code === 'CREDENTIAL_LEASE_ACCESS_DENIED',
  );
  assert.equal(issuerCalled, false);
});

test('rejects a tenant connector from another tenant before authorization', async () => {
  let authorizationCalled = false;
  const service = new GovernedCredentialLeaseService(
    {
      authorize: async () => {
        authorizationCalled = true;
        throw new Error('must not be called');
      },
    },
    { issue: async () => { throw new Error('must not be called'); } },
    300,
  );

  await assert.rejects(
    service.issue(request, { ...connector, tenantId: 'tenant-2' }),
    (error: unknown) => error instanceof CredentialLeaseError &&
      error.code === 'CREDENTIAL_CONNECTOR_MISMATCH',
  );
  assert.equal(authorizationCalled, false);
});

test('rejects an issuer lease longer than the configured maximum', async () => {
  const service = new GovernedCredentialLeaseService(
    {
      authorize: async () => ({
        decisionId: 'decision-1',
        allowed: true,
        reasonKey: 'POLICY_ALLOWED',
      }),
    },
    {
      issue: async (input) => ({
        leaseReference: 'lease://overlong',
        tenantId: input.request.tenantId,
        connectorKey: input.request.connectorKey,
        credentialReference: input.credentialReference,
        authorizationDecisionId: input.authorizationDecisionId,
        issuedAt: '2026-08-26T00:00:00.000Z',
        expiresAt: '2026-08-26T00:05:01.000Z',
        auditReference: 'audit://credential-lease/overlong',
      }),
    },
    300,
  );

  await assert.rejects(
    service.issue(request, connector),
    (error: unknown) => error instanceof CredentialLeaseError &&
      error.code === 'CREDENTIAL_LEASE_INVALID',
  );
});
