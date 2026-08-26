import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialReference,
  GovernedCredentialRotationRevocationService,
  type CredentialRotationEvent,
} from '../src/index.ts';

const activated: CredentialRotationEvent = {
  eventId: '38100000-0000-0000-0000-000000000002',
  rotationReference: 'rotation://tenant-1/storage/1',
  sequence: 2,
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'security-admin-2',
  connectorKey: 'storage-primary',
  currentCredentialReference: credentialReference('vault://tenant-1/storage/v1'),
  replacementCredentialReference: credentialReference('vault://tenant-1/storage/v2'),
  eventType: 'ACTIVATED',
  authorizationDecisionId: 'decision-activate',
  reason: 'verified replacement credential',
  occurredAt: '2026-08-26T00:01:01.000Z',
  correlationId: 'correlation-activate',
  evidenceRefs: ['audit://rotation/activate/1'],
};
const request = {
  tenantId: 'tenant-1',
  rotationReference: activated.rotationReference,
  requestedBySubjectId: 'security-admin-3',
  reason: 'replacement confirmed active',
  requestedAt: '2026-08-26T00:02:00.000Z',
  correlationId: 'correlation-revoke',
  evidenceRefs: ['verification://credential/active/1'],
} as const;

test('revokes only the superseded reference and audits before success', async () => {
  const calls: string[] = [];
  const service = new GovernedCredentialRotationRevocationService(
    {
      load: async () => {
        calls.push('load');
        return [activated];
      },
      append: async (event) => {
        calls.push('append');
        assert.equal(event.sequence, 3);
        return { appended: true, event };
      },
    },
    {
      authorize: async (input) => {
        calls.push('authorize');
        assert.equal(input.supersededCredentialReference, activated.currentCredentialReference);
        assert.equal(input.activeCredentialReference, activated.replacementCredentialReference);
        return { decisionId: 'decision-revoke', allowed: true, reasonKey: 'POLICY_ALLOWED' };
      },
    },
    {
      revoke: async (input) => {
        calls.push('revoke');
        return {
          rotationReference: input.activatedEvent.rotationReference,
          tenantId: input.request.tenantId,
          connectorKey: input.activatedEvent.connectorKey,
          revokedCredentialReference: input.activatedEvent.currentCredentialReference,
          activeCredentialReference: input.activatedEvent.replacementCredentialReference,
          authorizationDecisionId: input.authorizationDecisionId,
          status: 'REVOKED',
          revokedAt: '2026-08-26T00:02:01.000Z',
          auditReference: 'audit://rotation/revoke/1',
        };
      },
    },
    () => '38100000-0000-0000-0000-000000000003',
  );

  const result = await service.revoke(request);

  assert.deepEqual(calls, ['load', 'authorize', 'revoke', 'append']);
  assert.equal(result.activeCredentialReference, activated.replacementCredentialReference);
  assert.equal('secret' in result, false);
});

test('denial prevents superseded credential revocation', async () => {
  let revoked = false;
  const service = new GovernedCredentialRotationRevocationService(
    {
      load: async () => [activated],
      append: async () => { throw new Error('must not be called'); },
    },
    {
      authorize: async () => ({
        decisionId: 'decision-denied',
        allowed: false,
        reasonKey: 'COOLDOWN_ACTIVE',
      }),
    },
    {
      revoke: async () => {
        revoked = true;
        throw new Error('must not be called');
      },
    },
    () => 'unused',
  );

  await assert.rejects(
    service.revoke(request),
    /CREDENTIAL_ROTATION_REVOCATION_DENIED:COOLDOWN_ACTIVE/,
  );
  assert.equal(revoked, false);
});

test('rejects an attempt before activation', async () => {
  const service = new GovernedCredentialRotationRevocationService(
    {
      load: async () => [{ ...activated, sequence: 1, eventType: 'STAGED' }],
      append: async () => { throw new Error('must not be called'); },
    },
    { authorize: async () => { throw new Error('must not be called'); } },
    { revoke: async () => { throw new Error('must not be called'); } },
    () => 'unused',
  );

  await assert.rejects(service.revoke(request), /CREDENTIAL_ROTATION_NOT_ACTIVATED/);
});

test('rejects revoking the active replacement before audit append', async () => {
  let appended = false;
  const service = new GovernedCredentialRotationRevocationService(
    {
      load: async () => [activated],
      append: async (event) => {
        appended = true;
        return { appended: true, event };
      },
    },
    {
      authorize: async () => ({
        decisionId: 'decision-revoke',
        allowed: true,
        reasonKey: 'POLICY_ALLOWED',
      }),
    },
    {
      revoke: async () => ({
        rotationReference: activated.rotationReference,
        tenantId: activated.tenantId,
        connectorKey: activated.connectorKey,
        revokedCredentialReference: activated.replacementCredentialReference,
        activeCredentialReference: activated.currentCredentialReference,
        authorizationDecisionId: 'decision-revoke',
        status: 'REVOKED',
        revokedAt: '2026-08-26T00:02:01.000Z',
        auditReference: 'audit://rotation/revoke/wrong',
      }),
    },
    () => 'unused',
  );

  await assert.rejects(
    service.revoke(request),
    /CREDENTIAL_ROTATION_REVOCATION_INVALID/,
  );
  assert.equal(appended, false);
});
