import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CommunicationConsentRepository,
  CommunicationIntent,
  CommunicationSuppressionRepository,
  EffectiveCommunicationConsent,
  FindActiveSuppressionInput,
  PersistedCommunicationSuppression,
  ResolveEffectiveCommunicationConsentInput,
} from '../src/index.ts';
import { evaluatePersistedCommunicationPreflight } from '../src/persisted-preflight.ts';

const baseIntent: CommunicationIntent = {
  triggerKey: 'lead.followup',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  recipient: { email: ' Person@Example.com ' },
  variables: {},
  idempotencyKey: 'followup-1',
  purpose: 'marketing',
  consentRequired: true,
  channel: 'email',
};

function repositories(options: {
  consent?: EffectiveCommunicationConsent;
  suppression?: PersistedCommunicationSuppression | null;
}) {
  const consentCalls: ResolveEffectiveCommunicationConsentInput[] = [];
  const suppressionCalls: FindActiveSuppressionInput[] = [];

  const consent: CommunicationConsentRepository = {
    async record() {
      throw new Error('record is not used by preflight');
    },
    async resolveEffective(input) {
      consentCalls.push(input);
      return options.consent ?? { granted: false, scope: 'NONE', event: null };
    },
  };

  const suppression: CommunicationSuppressionRepository = {
    async findActive(input) {
      suppressionCalls.push(input);
      return options.suppression ?? null;
    },
    async add() {
      throw new Error('add is not used by preflight');
    },
    async revoke() {
      throw new Error('revoke is not used by preflight');
    },
  };

  return { consent, suppression, consentCalls, suppressionCalls };
}

test('uses normalized identity for persisted consent and suppression lookups', async () => {
  const repos = repositories({
    consent: { granted: true, scope: 'TENANT', event: null },
  });

  const decision = await evaluatePersistedCommunicationPreflight({
    intent: baseIntent,
    repositories: repos,
    at: '2026-08-25T04:00:00.000Z',
  });

  assert.equal(decision.reasonCode, 'OK');
  assert.deepEqual(repos.consentCalls, [{
    tenantId: baseIntent.tenantId,
    organizationId: baseIntent.organizationId,
    recipientKey: 'person@example.com',
    channel: 'email',
    purpose: 'marketing',
    at: '2026-08-25T04:00:00.000Z',
  }]);
  assert.deepEqual(repos.suppressionCalls, [{
    tenantId: baseIntent.tenantId,
    organizationId: baseIntent.organizationId,
    recipientKey: 'person@example.com',
    channel: 'email',
    at: '2026-08-25T04:00:00.000Z',
  }]);
});

test('missing persisted consent fails closed before any provider behavior', async () => {
  const repos = repositories({});
  const decision = await evaluatePersistedCommunicationPreflight({
    intent: baseIntent,
    repositories: repos,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'CONSENT_MISSING');
});

test('active persisted suppression refuses an otherwise consented communication', async () => {
  const repos = repositories({
    consent: { granted: true, scope: 'TENANT', event: null },
    suppression: {
      suppressionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      tenantId: baseIntent.tenantId,
      recipientKey: 'person@example.com',
      channel: 'email',
      reason: 'UNSUBSCRIBE',
      recordedAt: '2026-08-25T03:00:00.000Z',
    },
  });

  const decision = await evaluatePersistedCommunicationPreflight({
    intent: baseIntent,
    repositories: repos,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'SUPPRESSED');
});

test('channels without consent or suppression requirements skip both repositories', async () => {
  const repos = repositories({});
  const decision = await evaluatePersistedCommunicationPreflight({
    intent: {
      ...baseIntent,
      recipient: { subjectId: 'subject-1' },
      channel: 'in_app',
      purpose: 'system',
      consentRequired: false,
    },
    repositories: repos,
  });

  assert.equal(decision.reasonCode, 'OK');
  assert.equal(repos.consentCalls.length, 0);
  assert.equal(repos.suppressionCalls.length, 0);
});

test('invalid channel addressing fails before compliance repository reads', async () => {
  const repos = repositories({});

  await assert.rejects(
    evaluatePersistedCommunicationPreflight({
      intent: { ...baseIntent, recipient: { email: 'person@example.com' }, channel: 'sms' },
      repositories: repos,
    }),
    /Recipient is not addressable through sms/,
  );

  assert.equal(repos.consentCalls.length, 0);
  assert.equal(repos.suppressionCalls.length, 0);
});
