import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialReference,
  GovernedCredentialRotationActivationService,
  type CredentialRotationEvent,
} from '../src/index.ts';

const staged: CredentialRotationEvent = {
  eventId: '38100000-0000-0000-0000-000000000001',
  rotationReference: 'rotation://tenant-1/storage/1',
  sequence: 1,
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'security-admin-1',
  connectorKey: 'storage-primary',
  currentCredentialReference: credentialReference('vault://tenant-1/storage/v1'),
  replacementCredentialReference: credentialReference('vault://tenant-1/storage/v2'),
  eventType: 'STAGED',
  authorizationDecisionId: 'decision-stage',
  reason: 'scheduled rotation',
  occurredAt: '2026-08-26T00:00:00.000Z',
  correlationId: 'correlation-stage',
  evidenceRefs: ['change://credential/1'],
};
const request = {
  tenantId: 'tenant-1',
  rotationReference: staged.rotationReference,
  requestedBySubjectId: 'security-admin-2',
  reason: 'verified replacement credential',
  requestedAt: '2026-08-26T00:01:00.000Z',
  correlationId: 'correlation-activate',
  evidenceRefs: ['verification://credential/1'],
} as const;

test('authorizes and audits activation before reporting success', async () => {
  const calls: string[] = [];
  const service = new GovernedCredentialRotationActivationService(
    {
      load: async () => {
        calls.push('load');
        return [staged];
      },
      append: async (event) => {
        calls.push('append');
        return { appended: true, event };
      },
    },
    {
      authorize: async (input) => {
        calls.push('authorize');
        assert.equal(input.replacementCredentialReference, staged.replacementCredentialReference);
        return { decisionId: 'decision-activate', allowed: true, reasonKey: 'POLICY_ALLOWED' };
      },
    },
    {
      activate: async (input) => {
        calls.push('activate');
        return {
          rotationReference: input.stagedEvent.rotationReference,
          tenantId: input.request.tenantId,
          connectorKey: input.stagedEvent.connectorKey,
          currentCredentialReference: input.stagedEvent.currentCredentialReference,
          replacementCredentialReference: input.stagedEvent.replacementCredentialReference,
          authorizationDecisionId: input.authorizationDecisionId,
          status: 'ACTIVATED',
          activatedAt: '2026-08-26T00:01:01.000Z',
          auditReference: 'audit://rotation/activate/1',
        };
      },
    },
    () => '38100000-0000-0000-0000-000000000002',
  );

  const result = await service.activate(request);

  assert.deepEqual(calls, ['load', 'authorize', 'activate', 'append']);
  assert.equal(result.status, 'ACTIVATED');
  assert.equal('secret' in result, false);
});

test('authorization denial prevents provider activation', async () => {
  let activated = false;
  const service = new GovernedCredentialRotationActivationService(
    {
      load: async () => [staged],
      append: async () => { throw new Error('must not be called'); },
    },
    {
      authorize: async () => ({
        decisionId: 'decision-denied',
        allowed: false,
        reasonKey: 'SEPARATION_OF_DUTIES',
      }),
    },
    {
      activate: async () => {
        activated = true;
        throw new Error('must not be called');
      },
    },
    () => 'unused',
  );

  await assert.rejects(
    service.activate(request),
    /CREDENTIAL_ROTATION_ACTIVATION_DENIED:SEPARATION_OF_DUTIES/,
  );
  assert.equal(activated, false);
});

test('rejects provider identity mismatch before audit append', async () => {
  let appended = false;
  const service = new GovernedCredentialRotationActivationService(
    {
      load: async () => [staged],
      append: async (event) => {
        appended = true;
        return { appended: true, event };
      },
    },
    {
      authorize: async () => ({
        decisionId: 'decision-activate',
        allowed: true,
        reasonKey: 'POLICY_ALLOWED',
      }),
    },
    {
      activate: async () => ({
        rotationReference: staged.rotationReference,
        tenantId: 'tenant-2',
        connectorKey: staged.connectorKey,
        currentCredentialReference: staged.currentCredentialReference,
        replacementCredentialReference: staged.replacementCredentialReference,
        authorizationDecisionId: 'decision-activate',
        status: 'ACTIVATED',
        activatedAt: '2026-08-26T00:01:01.000Z',
        auditReference: 'audit://rotation/activate/1',
      }),
    },
    () => 'unused',
  );

  await assert.rejects(
    service.activate(request),
    /CREDENTIAL_ROTATION_ACTIVATION_INVALID/,
  );
  assert.equal(appended, false);
});

test('requires a staged terminal event', async () => {
  const service = new GovernedCredentialRotationActivationService(
    {
      load: async () => [{ ...staged, sequence: 2, eventType: 'ACTIVATED' }],
      append: async () => { throw new Error('must not be called'); },
    },
    { authorize: async () => { throw new Error('must not be called'); } },
    { activate: async () => { throw new Error('must not be called'); } },
    () => 'unused',
  );

  await assert.rejects(service.activate(request), /CREDENTIAL_ROTATION_NOT_STAGED/);
});
