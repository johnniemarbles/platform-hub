import assert from 'node:assert/strict';
import test from 'node:test';

import { AuditedCredentialLeaseIssuer } from '../src/audited-credential-issuer.ts';
import {
  credentialReference,
  type CredentialLeaseAuditEvent,
  type CredentialLeaseIssuerInput,
} from '../src/index.ts';

const input: CredentialLeaseIssuerInput = {
  request: {
    requestId: 'request-1',
    tenantId: 'tenant-1',
    requestedBySubjectId: 'subject-1',
    connectorKey: 'storage-primary',
    purpose: 'object.write',
    requestedAt: '2026-08-26T00:00:00.000Z',
    correlationId: 'correlation-1',
    evidenceRefs: ['approval://credential/1'],
  },
  credentialReference: credentialReference('vault://tenant-1/storage'),
  authorizationDecisionId: 'decision-1',
  authorizationReasonKey: 'POLICY_ALLOWED',
  maximumLeaseSeconds: 300,
};

const lease = {
  leaseReference: 'lease://1',
  tenantId: 'tenant-1',
  connectorKey: 'storage-primary',
  credentialReference: input.credentialReference,
  authorizationDecisionId: 'decision-1',
  issuedAt: '2026-08-26T00:00:01.000Z',
  expiresAt: '2026-08-26T00:05:01.000Z',
  auditReference: 'audit://issuer/1',
} as const;

test('persists the immutable audit event before reporting issuance success', async () => {
  const calls: string[] = [];
  let stored: CredentialLeaseAuditEvent | undefined;
  const issuer = new AuditedCredentialLeaseIssuer(
    {
      issue: async () => {
        calls.push('provider');
        return lease;
      },
    },
    {
      record: async (event) => {
        calls.push('audit');
        stored = event;
        return { recorded: true, event };
      },
      findByRequest: async () => undefined,
    },
    () => '37100000-0000-0000-0000-000000000001',
    () => '2026-08-26T00:00:02.000Z',
  );

  const result = await issuer.issue(input);

  assert.deepEqual(calls, ['provider', 'audit']);
  assert.equal(result, lease);
  assert.equal(stored?.authorizationReasonKey, 'POLICY_ALLOWED');
  assert.equal(stored?.leaseReference, 'lease://1');
  assert.equal('secret' in (stored ?? {}), false);
});

test('does not report success when immutable audit persistence fails', async () => {
  const issuer = new AuditedCredentialLeaseIssuer(
    { issue: async () => lease },
    {
      record: async () => {
        throw new Error('AUDIT_UNAVAILABLE');
      },
      findByRequest: async () => undefined,
    },
    () => '37100000-0000-0000-0000-000000000001',
    () => '2026-08-26T00:00:02.000Z',
  );

  await assert.rejects(issuer.issue(input), /AUDIT_UNAVAILABLE/);
});

test('rejects an audit repository response for a different request', async () => {
  const issuer = new AuditedCredentialLeaseIssuer(
    { issue: async () => lease },
    {
      record: async (event) => ({
        recorded: false,
        event: {
          ...event,
          request: { ...event.request, requestId: 'different-request' },
        },
      }),
      findByRequest: async () => undefined,
    },
    () => '37100000-0000-0000-0000-000000000001',
    () => '2026-08-26T00:00:02.000Z',
  );

  await assert.rejects(issuer.issue(input), /CREDENTIAL_LEASE_AUDIT_MISMATCH/);
});
