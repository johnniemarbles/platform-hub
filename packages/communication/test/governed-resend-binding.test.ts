import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition, CredentialReference } from '@platform-hub/provider-registry';
import {
  GovernedResendCredentialError,
  governedResendApiTokenProvider,
} from '../src/governed-resend-binding.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const credentialRef = 'vault://tenant-a/resend' as CredentialReference;
const connector: ConnectorDefinition = {
  connectorKey: 'tenant-email-primary',
  providerType: 'email',
  providerKey: 'resend',
  ownership: 'TENANT',
  tenantId,
  capabilityKeys: ['communication.email.send'],
  residencyTags: ['CA'],
  complianceTags: ['PIPEDA'],
  health: 'HEALTHY',
  priority: 1,
  enabled: true,
  fallbackEnabled: false,
};
const request = {
  tenantId,
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  triggerKey: 'lead.welcome',
  idempotencyKey: 'welcome-1',
  purpose: 'transactional' as const,
  requestedAt: '2026-08-26T18:00:00.000Z',
};

test('loads, leases, audits, then resolves a connector-bound Resend credential', async () => {
  const calls: string[] = [];
  const provider = governedResendApiTokenProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-1',
    correlationId: () => 'correlation-1',
    now: () => '2026-08-26T18:00:00.000Z',
    credentialRepository: {
      async loadCredentialReference(actualTenantId, connectorKey) {
        calls.push(`reference:${actualTenantId}:${connectorKey}`);
        return credentialRef;
      },
    },
    leaseService: {
      async issue(actualRequest, actualConnector) {
        calls.push(`lease:${actualRequest.requestId}`);
        assert.equal(actualConnector.credentialRef, credentialRef);
        assert.deepEqual(actualRequest.evidenceRefs, [
          'communication://trigger/lead.welcome',
          'communication://idempotency/welcome-1',
        ]);
        return {
          leaseReference: 'lease://resend/1',
          tenantId,
          connectorKey: connector.connectorKey,
          credentialReference: credentialRef,
          authorizationDecisionId: 'decision-1',
          issuedAt: '2026-08-26T17:59:59.000Z',
          expiresAt: '2026-08-26T18:05:00.000Z',
          auditReference: 'audit://credential-lease/1',
        };
      },
    },
    secretResolver: {
      async resolve(reference) {
        calls.push(`secret:${reference}`);
        return { value: 're_live_token', version: '7' };
      },
    },
  });

  assert.equal(await provider(request), 're_live_token');
  assert.deepEqual(calls, [
    `reference:${tenantId}:tenant-email-primary`,
    'lease:credential-request-1',
    'secret:vault://tenant-a/resend',
  ]);
});

test('missing credential reference fails before authorization and secret resolution', async () => {
  let leaseCalled = false;
  let secretCalled = false;
  const provider = governedResendApiTokenProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-2',
    correlationId: () => 'correlation-2',
    now: () => '2026-08-26T18:00:00.000Z',
    credentialRepository: { async loadCredentialReference() { return null; } },
    leaseService: { async issue() { leaseCalled = true; throw new Error('must not run'); } },
    secretResolver: { async resolve() { secretCalled = true; throw new Error('must not run'); } },
  });

  await assert.rejects(
    () => provider(request),
    (error: unknown) => error instanceof GovernedResendCredentialError
      && error.code === 'RESEND_CREDENTIAL_REFERENCE_UNAVAILABLE',
  );
  assert.equal(leaseCalled, false);
  assert.equal(secretCalled, false);
});

test('rejects invalid connectors before credential repository access', () => {
  let repositoryCalled = false;
  assert.throws(
    () => governedResendApiTokenProvider({
      connector: { ...connector, providerKey: 'sendgrid' },
      requestedBySubjectId: 'worker:communication-dispatch',
      requestId: () => 'credential-request-3',
      correlationId: () => 'correlation-3',
      now: () => '2026-08-26T18:00:00.000Z',
      credentialRepository: { async loadCredentialReference() { repositoryCalled = true; return credentialRef; } },
      leaseService: { async issue() { throw new Error('must not run'); } },
      secretResolver: { async resolve() { throw new Error('must not run'); } },
    }),
    (error: unknown) => error instanceof GovernedResendCredentialError
      && error.code === 'RESEND_CONNECTOR_INVALID',
  );
  assert.equal(repositoryCalled, false);
});

test('does not release an expired resolved secret to the provider adapter', async () => {
  const provider = governedResendApiTokenProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-4',
    correlationId: () => 'correlation-4',
    now: () => '2026-08-26T18:00:00.000Z',
    credentialRepository: { async loadCredentialReference() { return credentialRef; } },
    leaseService: {
      async issue() {
        return {
          leaseReference: 'lease://resend/4', tenantId, connectorKey: connector.connectorKey,
          credentialReference: credentialRef, authorizationDecisionId: 'decision-4',
          issuedAt: '2026-08-26T17:59:59.000Z', expiresAt: '2026-08-26T18:05:00.000Z',
          auditReference: 'audit://credential-lease/4',
        };
      },
    },
    secretResolver: {
      async resolve() { return { value: 'expired', expiresAt: new Date('2026-08-26T17:59:00.000Z') }; },
    },
  });

  await assert.rejects(
    () => provider(request),
    (error: unknown) => error instanceof GovernedResendCredentialError
      && error.code === 'RESEND_SECRET_EXPIRED',
  );
});
