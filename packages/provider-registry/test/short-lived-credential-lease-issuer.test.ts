import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEND_CREDENTIAL_LEASE_TTL_SECONDS,
  ShortLivedCredentialLeaseIssuer,
} from '../src/short-lived-credential-lease-issuer.ts';
import {
  credentialReference,
  type CredentialLeaseIssuerInput,
} from '../src/index.ts';

const input: CredentialLeaseIssuerInput = {
  request: {
    requestId: 'request-1',
    tenantId: 'tenant-1',
    requestedBySubjectId: 'subject-1',
    connectorKey: 'resend-primary',
    purpose: 'communication.email.send:system',
    requestedAt: '2026-08-30T04:00:00.000Z',
    correlationId: 'correlation-1',
    evidenceRefs: ['communication://test-send/1'],
  },
  credentialReference: credentialReference('vault://tenant/11111111-1111-1111-1111-111111111111/connector/resend-primary/v3'),
  authorizationDecisionId: 'decision-1',
  authorizationReasonKey: 'POLICY_ALLOWED',
  maximumLeaseSeconds: 300,
};

test('issues a reference-only send lease capped at 60 seconds', async () => {
  const issuer = new ShortLivedCredentialLeaseIssuer({
    now: () => '2026-08-30T04:00:01.000Z',
    leaseId: () => 'lease-1',
    auditId: () => 'audit-1',
  });

  const lease = await issuer.issue(input);

  assert.equal(SEND_CREDENTIAL_LEASE_TTL_SECONDS, 60);
  assert.equal(lease.leaseReference, 'lease://credential/lease-1');
  assert.equal(lease.auditReference, 'audit://credential-lease/audit-1');
  assert.equal(lease.issuedAt, '2026-08-30T04:00:01.000Z');
  assert.equal(lease.expiresAt, '2026-08-30T04:01:01.000Z');
  assert.equal(lease.credentialReference, input.credentialReference);
  assert.equal('secret' in lease, false);
  assert.equal('value' in lease, false);
});

test('honors a stricter caller maximum than the send-path TTL', async () => {
  const issuer = new ShortLivedCredentialLeaseIssuer({
    now: () => '2026-08-30T04:00:01.000Z',
    leaseId: () => 'lease-2',
    auditId: () => 'audit-2',
  });

  const lease = await issuer.issue({ ...input, maximumLeaseSeconds: 15 });
  assert.equal(lease.expiresAt, '2026-08-30T04:00:16.000Z');
});

test('rejects configuration above the 60-second send-path ceiling', () => {
  assert.throws(
    () => new ShortLivedCredentialLeaseIssuer({ ttlSeconds: 61 }),
    /CREDENTIAL_LEASE_TTL_INVALID/,
  );
});

test('rejects unstable generated references and invalid clocks', async () => {
  await assert.rejects(
    new ShortLivedCredentialLeaseIssuer({
      now: () => 'not-a-date',
      leaseId: () => 'lease-3',
      auditId: () => 'audit-3',
    }).issue(input),
    /CREDENTIAL_LEASE_ISSUED_AT_INVALID/,
  );

  await assert.rejects(
    new ShortLivedCredentialLeaseIssuer({
      now: () => '2026-08-30T04:00:01.000Z',
      leaseId: () => 'bad/lease',
      auditId: () => 'audit-4',
    }).issue(input),
    /CREDENTIAL_LEASE_ID_INVALID/,
  );
});
