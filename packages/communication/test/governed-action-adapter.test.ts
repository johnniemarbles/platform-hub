import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type {
  CommunicationConsentRepository,
  CommunicationSuppressionRepository,
  CommunicationTemplateRepository,
} from '../src/index.ts';
import type {
  CommunicationDeliveryRecord,
  CommunicationDeliveryRepository,
} from '../src/delivery-repository.ts';
import type { GovernedActionIntent } from '@expadio/governed-actions';
import {
  queueGovernedCommunicateAction,
} from '../src/governed-action-adapter.ts';

const actionIntent: GovernedActionIntent = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceEventId: '11111111-1111-4111-8111-111111111111',
  sourceEventType: 'ServiceRequest.Completed',
  aggregateType: 'crm.case',
  aggregateId: 'service-request-1',
  ruleKey: 'acme-corp.completed.follow-up',
  executorClass: 'COMMUNICATE',
  actionKey: 'client.follow_up',
  idempotencyKey:
    '11111111-1111-4111-8111-111111111111:acme-corp.completed.follow-up:COMMUNICATE',
  correlationId: 'journey-1',
  causationId: '11111111-1111-4111-8111-111111111111',
  requestedBySubjectId: 'reviewer-1',
  requestedAt: new Date('2026-08-30T10:00:00.000Z'),
  configuration: {
    triggerKey: 'client.follow_up',
    recipient: { email: 'client@example.test' },
    variables: { clientName: 'Jane' },
    purpose: 'transactional',
    consentRequired: false,
    channel: 'email',
    locale: 'en',
    capabilityKey: 'communication.email.send',
  },
  policyDecision: {
    allowed: true,
    policyKeys: ['patient-contactable'],
    evidenceRefs: ['patient:email'],
    reasonCode: 'ALLOWED',
    evaluatedAt: new Date('2026-08-30T10:00:00.000Z'),
  },
};

function connector(): ConnectorDefinition {
  return {
    connectorKey: 'resend-primary',
    providerType: 'email',
    providerKey: 'resend',
    ownership: 'PLATFORM',
    capabilityKeys: ['communication.email.send'],
    region: 'ca-central-1',
    residencyTags: ['CA'],
    complianceTags: ['SOC2'],
    health: 'HEALTHY',
    priority: 1,
    enabled: true,
    fallbackEnabled: true,
  };
}

function consent(): CommunicationConsentRepository {
  return {
    async record() {
      throw new Error('not used');
    },
    async resolveEffective() {
      return { granted: true, scope: 'TENANT', event: null };
    },
  };
}

function suppression(
  captureAt: string[],
  active = false,
): CommunicationSuppressionRepository {
  return {
    async findActive(input) {
      if (input.at !== undefined) captureAt.push(input.at);
      return active
        ? {
            suppressionId: 'suppression-1',
            tenantId: actionIntent.tenantId,
            recipientKey: 'patient@example.test',
            channel: 'email',
            reason: 'OPT_OUT',
            recordedAt: '2026-08-30T10:05:00.000Z',
          }
        : null;
    },
    async add() {
      throw new Error('not used');
    },
    async revoke() {
      throw new Error('not used');
    },
  };
}

function templates(): CommunicationTemplateRepository {
  return {
    async resolveActive() {
      return {
        matchedScope: 'PLATFORM',
        template: {
          templateId: 'follow-up-template',
          scope: { kind: 'PLATFORM' },
          key: {
            triggerKey: 'patient.follow_up',
            channel: 'email',
            locale: 'en',
          },
          content: {
            format: 'TEXT',
            subject: 'Treatment follow-up',
            body: 'Hello {{patientName}}',
          },
          requiredVariables: ['patientName'],
          defaultVariables: {},
          version: 1,
          status: 'ACTIVE',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:00.000Z',
        },
      };
    },
  };
}

function delivery(
  writes: Array<{ idempotencyKey: string; connectorKey: string }>,
): CommunicationDeliveryRepository {
  const record: CommunicationDeliveryRecord = {
    deliveryId: '22222222-2222-4222-8222-222222222222',
    tenantId: actionIntent.tenantId,
    idempotencyKey: actionIntent.idempotencyKey,
    channel: 'email',
    connectorKey: 'resend-primary',
    adapterKey: 'resend-email-v1',
    state: 'PENDING',
    attemptCount: 0,
    requestedAt: '2026-08-30T10:10:00.000Z',
    updatedAt: '2026-08-30T10:10:00.000Z',
  };
  return {
    async createOrGet(input) {
      writes.push({
        idempotencyKey: input.idempotencyKey,
        connectorKey: input.connectorKey,
      });
      return record;
    },
    async findByIdempotencyKey() {
      return record;
    },
    async findByProviderMessageId() {
      return null;
    },
    async recordAttempt() {
      return record;
    },
    async applyTransition() {
      return { applied: false, delivery: record };
    },
  };
}

test('governed action queues through the existing Communications delivery boundary', async () => {
  const writes: Array<{ idempotencyKey: string; connectorKey: string }> = [];
  const evaluatedAt: string[] = [];
  const result = await queueGovernedCommunicateAction(actionIntent, {
    compliance: {
      consent: consent(),
      suppression: suppression(evaluatedAt),
    },
    templates: templates(),
    delivery: delivery(writes),
    connectors: [connector()],
    now: () => '2026-08-30T10:10:00.000Z',
  });

  assert.equal(result.queued, true);
  if (!result.queued) throw new Error('expected queued communication');

  assert.equal(result.communicationIntent.idempotencyKey, actionIntent.idempotencyKey);
  assert.equal(result.preparedDispatch.idempotencyKey, actionIntent.idempotencyKey);
  assert.equal(result.connector.connectorKey, 'resend-primary');
  assert.equal(result.delivery.adapterKey, 'resend-email-v1');
  assert.deepEqual(writes, [{
    idempotencyKey: actionIntent.idempotencyKey,
    connectorKey: 'resend-primary',
  }]);
  assert.deepEqual(evaluatedAt, ['2026-08-30T10:10:00.000Z']);
});

test('execution-time suppression prevents delivery creation', async () => {
  const writes: Array<{ idempotencyKey: string; connectorKey: string }> = [];
  const evaluatedAt: string[] = [];
  const result = await queueGovernedCommunicateAction(actionIntent, {
    compliance: {
      consent: consent(),
      suppression: suppression(evaluatedAt, true),
    },
    templates: templates(),
    delivery: delivery(writes),
    connectors: [connector()],
    now: () => '2026-08-30T10:10:00.000Z',
  });

  assert.equal(result.queued, false);
  if (result.queued) throw new Error('expected suppression refusal');
  assert.equal(result.reasonCode, 'SUPPRESSED');
  assert.deepEqual(writes, []);
  assert.deepEqual(evaluatedAt, ['2026-08-30T10:10:00.000Z']);
});
