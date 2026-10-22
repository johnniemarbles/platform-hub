import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeTokenCredentialLeaseAuthorizer } from '../src/scope-token-authorizer.ts';
import { credentialReference } from '../src/index.ts';
import type { CredentialLeaseAuthorizationQuery } from '../src/credential-access.ts';

let ids = 0;
const decisionId = () => `dec_${++ids}`;

const baseQuery = (overrides: Partial<CredentialLeaseAuthorizationQuery> = {}): CredentialLeaseAuthorizationQuery => ({
  action: 'credential.lease',
  requestId: 'req_1',
  tenantId: 'tnt_A',
  requestedBySubjectId: 'usr_42',
  connectorKey: 'twilio.sms.tnt_A',
  purpose: 'customer-notification',
  requestedAt: '2026-10-22T00:00:00.000Z',
  correlationId: 'corr_1',
  evidenceRefs: [],
  credentialReference: credentialReference('secret://vault/tnt_A/twilio'),
  ...overrides,
});

const baseClaims = (overrides: Partial<ConstructorParameters<typeof ScopeTokenCredentialLeaseAuthorizer>[0]['claims']> = {}) => ({
  tenantId: 'tnt_A',
  appId: 'app_dentex',
  sub: 'usr_42',
  permissions: ['credential.lease'],
  credentialClass: 'platform-operational' as const,
  ...overrides,
});

test('allows a lease when the token names the same tenant, subject, and permission', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims(), decisionId });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, true);
  assert.equal(d.reasonKey, 'CREDENTIAL_LEASE_ALLOWED');
  assert.match(d.decisionId, /^dec_/);
});

test('refuses a lease for a tenant the token does not cover', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims({ tenantId: 'tnt_B' }), decisionId });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, false);
  assert.equal(d.reasonKey, 'CREDENTIAL_CONTEXT_MISMATCH');
});

test('refuses a lease on behalf of a subject the token did not sign for', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims({ sub: 'usr_other' }), decisionId });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, false);
  assert.equal(d.reasonKey, 'CREDENTIAL_CONTEXT_MISMATCH');
});

test('refuses when the required permission is missing', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims({ permissions: ['other.action'] }), decisionId });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, false);
  assert.equal(d.reasonKey, 'CREDENTIAL_PERMISSION_MISSING');
});

test('refuses a tenant-byok lease when the token carries no grantId (plan rule 5)', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({
    claims: baseClaims({ credentialClass: 'tenant-byok' as const }),
    decisionId,
  });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, false);
  assert.equal(d.reasonKey, 'CREDENTIAL_GRANT_MISSING');
});

test('allows a tenant-byok lease when the token carries a grantId', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({
    claims: baseClaims({ credentialClass: 'tenant-byok' as const, grantId: 'gr_123' }),
    decisionId,
  });
  const d = await a.authorize(baseQuery());
  assert.equal(d.allowed, true);
});

test('refuses an action other than credential.lease', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims(), decisionId });
  const d = await a.authorize({ ...baseQuery(), action: 'other' as 'credential.lease' });
  assert.equal(d.allowed, false);
  assert.equal(d.reasonKey, 'CREDENTIAL_LEASE_ACTION_INVALID');
});

test('rejects malformed decision ids at the type boundary', async () => {
  const a = new ScopeTokenCredentialLeaseAuthorizer({ claims: baseClaims(), decisionId: () => '  bad\nid  ' });
  await assert.rejects(a.authorize(baseQuery()));
});
