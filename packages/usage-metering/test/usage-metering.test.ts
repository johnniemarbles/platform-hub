import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UsageMeteringError,
  evaluateMonthlyUsageBudget,
  validateIntelligenceUsageEvent,
  type IntelligenceUsageEvent,
  type MonthlyUsageBudgetPolicy,
  type UsageBudgetPosition,
} from '../src/index.ts';

const usage: IntelligenceUsageEvent = {
  eventId: 'usage-1',
  tenantId: 'tenant-1',
  organizationId: 'organization-1',
  meter: 'AI_OUTPUT_TOKEN',
  quantity: 500,
  costMinorUnits: 30,
  currency: 'USD',
  capabilityKey: 'ai.generate',
  connectorKey: 'tenant-llm',
  providerKey: 'customer-provider',
  modelKey: 'model-1',
  providerCostOwnership: 'BYOK',
  workReference: 'ai-job://job-1',
  occurredAt: '2026-08-25T21:00:00.000Z',
  recordedAt: '2026-08-25T21:00:01.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['provider-response://request-1'],
};

const policy: MonthlyUsageBudgetPolicy = {
  policyKey: 'monthly-ai-budget',
  version: 3,
  tenantId: 'tenant-1',
  organizationId: 'organization-1',
  currency: 'USD',
  softLimitMinorUnits: 800,
  hardLimitMinorUnits: 1000,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  effectiveUntil: null,
};

const position: UsageBudgetPosition = {
  tenantId: 'tenant-1',
  organizationId: 'organization-1',
  currency: 'USD',
  period: '2026-08',
  committedCostMinorUnits: 700,
};

test('retains BYOK provider and work attribution without credentials', () => {
  const validated = validateIntelligenceUsageEvent(usage);

  assert.equal(validated.providerCostOwnership, 'BYOK');
  assert.equal(validated.connectorKey, 'tenant-llm');
  assert.equal(validated.workReference, 'ai-job://job-1');
  assert.equal('credential' in validated, false);
});

test('allows usage below the soft limit', () => {
  assert.deepEqual(
    evaluateMonthlyUsageBudget(
      policy,
      { ...position, committedCostMinorUnits: 700 },
      { ...usage, costMinorUnits: 50 },
    ),
    {
      status: 'ALLOW',
      projectedCostMinorUnits: 750,
      remainingHardLimitMinorUnits: 250,
    },
  );
});

test('emits a soft alert while retaining hard-limit headroom', () => {
  assert.deepEqual(
    evaluateMonthlyUsageBudget(
      policy,
      { ...position, committedCostMinorUnits: 780 },
      usage,
    ),
    {
      status: 'ALLOW_WITH_ALERT',
      reasonKey: 'SOFT_LIMIT_REACHED',
      projectedCostMinorUnits: 810,
      remainingHardLimitMinorUnits: 190,
    },
  );
});

test('denies usage that would exceed the hard limit', () => {
  assert.deepEqual(
    evaluateMonthlyUsageBudget(
      policy,
      { ...position, committedCostMinorUnits: 980 },
      usage,
    ),
    {
      status: 'DENY',
      reasonKey: 'HARD_LIMIT_EXCEEDED',
      projectedCostMinorUnits: 1010,
      remainingHardLimitMinorUnits: 0,
    },
  );
});

test('rejects cross-scope or cross-currency evaluation', () => {
  assert.throws(
    () =>
      evaluateMonthlyUsageBudget(
        policy,
        { ...position, organizationId: 'organization-2' },
        usage,
      ),
    (error: unknown) =>
      error instanceof UsageMeteringError
      && error.code === 'USAGE_BUDGET_SCOPE_MISMATCH',
  );
  assert.throws(
    () =>
      evaluateMonthlyUsageBudget(
        policy,
        { ...position, currency: 'EUR' },
        usage,
      ),
    (error: unknown) =>
      error instanceof UsageMeteringError
      && error.code === 'USAGE_BUDGET_CURRENCY_MISMATCH',
  );
});

test('rejects negative or fractional usage', () => {
  assert.throws(
    () =>
      validateIntelligenceUsageEvent({
        ...usage,
        quantity: -1,
        costMinorUnits: 1.5,
      }),
    (error: unknown) =>
      error instanceof UsageMeteringError
      && error.code === 'USAGE_EVENT_INVALID',
  );
});
