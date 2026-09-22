import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition, CredentialReference } from '@platform-hub/provider-registry';
import {
  GovernedTwilioCredentialError,
  governedTwilioCredentialsProvider,
} from '../src/governed-twilio-binding.ts';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const credentialRef = 'vault://tenant-a/twilio' as CredentialReference;
const connector: ConnectorDefinition = {
  connectorKey: 'platform-twilio-sms',
  providerType: 'sms',
  providerKey: 'twilio-sms',
  ownership: 'PLATFORM',
  capabilityKeys: ['communication.sms.send'],
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
  triggerKey: 'communications.test-send',
  idempotencyKey: 'twilio-test-1',
  purpose: 'system',
  requestedAt: '2026-09-02T15:30:00.000Z',
};

test('leases then resolves structured Twilio credentials', async () => {
  const calls: string[] = [];
  const provider = governedTwilioCredentialsProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-1',
    correlationId: () => 'correlation-1',
    now: () => request.requestedAt,
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
        assert.equal(actualRequest.purpose, 'communication.sms.send:system');
        return {
          leaseReference: 'lease://twilio/1', tenantId,
          connectorKey: connector.connectorKey, credentialReference: credentialRef,
          authorizationDecisionId: 'decision-1',
          issuedAt: '2026-09-02T15:29:59.000Z', expiresAt: '2026-09-02T15:35:00.000Z',
          auditReference: 'audit://credential-lease/1',
        };
      },
    },
    secretResolver: {
      async resolve(reference) {
        calls.push(`secret:${reference}`);
        return { value: JSON.stringify({ accountSid: 'AC123', authToken: 'token', messagingServiceSid: 'MG123' }) };
      },
    },
  });

  assert.deepEqual(await provider(request), {
    accountSid: 'AC123', authToken: 'token', messagingServiceSid: 'MG123',
  });
  assert.deepEqual(calls, [
    `reference:${tenantId}:platform-twilio-sms`,
    'lease:credential-request-1',
    'secret:vault://tenant-a/twilio',
  ]);
});

test('rejects provider/capability mismatches before repository access', () => {
  let repositoryCalled = false;
  assert.throws(
    () => governedTwilioCredentialsProvider({
      connector: { ...connector, providerKey: 'twilio-whatsapp' },
      requestedBySubjectId: 'worker:communication-dispatch',
      requestId: () => 'credential-request-2', correlationId: () => 'correlation-2',
      credentialRepository: { async loadCredentialReference() { repositoryCalled = true; return credentialRef; } },
      leaseService: { async issue() { throw new Error('must not run'); } },
      secretResolver: { async resolve() { throw new Error('must not run'); } },
    }),
    (error: unknown) => error instanceof GovernedTwilioCredentialError
      && error.code === 'TWILIO_CONNECTOR_INVALID',
  );
  assert.equal(repositoryCalled, false);
});

test('rejects malformed secret payloads after lease authorization', async () => {
  const provider = governedTwilioCredentialsProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-3', correlationId: () => 'correlation-3',
    now: () => request.requestedAt,
    credentialRepository: { async loadCredentialReference() { return credentialRef; } },
    leaseService: {
      async issue() {
        return {
          leaseReference: 'lease://twilio/3', tenantId,
          connectorKey: connector.connectorKey, credentialReference: credentialRef,
          authorizationDecisionId: 'decision-3',
          issuedAt: '2026-09-02T15:29:59.000Z', expiresAt: '2026-09-02T15:35:00.000Z',
          auditReference: 'audit://credential-lease/3',
        };
      },
    },
    secretResolver: { async resolve() { return { value: 'not-json' }; } },
  });

  await assert.rejects(
    () => provider(request),
    (error: unknown) => error instanceof GovernedTwilioCredentialError
      && error.code === 'TWILIO_SECRET_INVALID',
  );
});

test('missing credential reference fails closed before lease and resolution', async () => {
  let leaseCalled = false;
  let secretCalled = false;
  const provider = governedTwilioCredentialsProvider({
    connector,
    requestedBySubjectId: 'worker:communication-dispatch',
    requestId: () => 'credential-request-4', correlationId: () => 'correlation-4',
    credentialRepository: { async loadCredentialReference() { return null; } },
    leaseService: { async issue() { leaseCalled = true; throw new Error('must not run'); } },
    secretResolver: { async resolve() { secretCalled = true; throw new Error('must not run'); } },
  });

  await assert.rejects(
    () => provider(request),
    (error: unknown) => error instanceof GovernedTwilioCredentialError
      && error.code === 'TWILIO_CREDENTIAL_REFERENCE_UNAVAILABLE',
  );
  assert.equal(leaseCalled, false);
  assert.equal(secretCalled, false);
});
