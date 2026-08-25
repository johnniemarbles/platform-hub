export type IntelligenceUsageMeter =
  | 'AI_REQUEST'
  | 'AI_INPUT_TOKEN'
  | 'AI_OUTPUT_TOKEN'
  | 'VOICE_MILLISECOND'
  | 'AGENT_TOOL_STEP';

export type ProviderCostOwnership =
  | 'EXPADIO_MANAGED'
  | 'BYOK'
  | 'CUSTOMER_PROVIDER';

export interface IntelligenceUsageEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly meter: IntelligenceUsageMeter;
  readonly quantity: number;
  readonly costMinorUnits: number;
  readonly currency: string;
  readonly capabilityKey: string;
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly modelKey: string | null;
  readonly providerCostOwnership: ProviderCostOwnership;
  readonly workReference: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface MonthlyUsageBudgetPolicy {
  readonly policyKey: string;
  readonly version: number;
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly currency: string;
  readonly softLimitMinorUnits: number | null;
  readonly hardLimitMinorUnits: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}

export interface UsageBudgetPosition {
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly currency: string;
  readonly period: string;
  readonly committedCostMinorUnits: number;
}

export type UsageBudgetDecision =
  | {
      readonly status: 'ALLOW';
      readonly projectedCostMinorUnits: number;
      readonly remainingHardLimitMinorUnits: number;
    }
  | {
      readonly status: 'ALLOW_WITH_ALERT';
      readonly projectedCostMinorUnits: number;
      readonly remainingHardLimitMinorUnits: number;
      readonly reasonKey: 'SOFT_LIMIT_REACHED';
    }
  | {
      readonly status: 'DENY';
      readonly projectedCostMinorUnits: number;
      readonly remainingHardLimitMinorUnits: number;
      readonly reasonKey: 'HARD_LIMIT_EXCEEDED';
    };

export type UsageMeteringErrorCode =
  | 'USAGE_EVENT_INVALID'
  | 'USAGE_POLICY_INVALID'
  | 'USAGE_POSITION_INVALID'
  | 'USAGE_BUDGET_SCOPE_MISMATCH'
  | 'USAGE_BUDGET_CURRENCY_MISMATCH';

export class UsageMeteringError extends Error {
  readonly code: UsageMeteringErrorCode;

  constructor(code: UsageMeteringErrorCode, message: string) {
    super(message);
    this.name = 'UsageMeteringError';
    this.code = code;
  }
}

export function validateIntelligenceUsageEvent(
  event: IntelligenceUsageEvent,
): IntelligenceUsageEvent {
  if (
    !nonBlank(event.eventId)
    || !nonBlank(event.tenantId)
    || (
      event.organizationId !== null
      && !nonBlank(event.organizationId)
    )
    || !Number.isInteger(event.quantity)
    || event.quantity < 0
    || !Number.isInteger(event.costMinorUnits)
    || event.costMinorUnits < 0
    || !validCurrency(event.currency)
    || !nonBlank(event.capabilityKey)
    || !nonBlank(event.connectorKey)
    || !nonBlank(event.providerKey)
    || (event.modelKey !== null && !nonBlank(event.modelKey))
    || !nonBlank(event.workReference)
    || !validInstant(event.occurredAt)
    || !validInstant(event.recordedAt)
    || !nonBlank(event.correlationId)
    || !validEvidence(event.evidenceRefs)
  ) {
    throw new UsageMeteringError(
      'USAGE_EVENT_INVALID',
      'Usage events require governed attribution, non-negative quantity and cost, provider ownership, time, correlation, and evidence.',
    );
  }
  return event;
}

export function evaluateMonthlyUsageBudget(
  policy: MonthlyUsageBudgetPolicy,
  position: UsageBudgetPosition,
  candidate: IntelligenceUsageEvent,
): UsageBudgetDecision {
  validatePolicy(policy);
  validatePosition(position);
  validateIntelligenceUsageEvent(candidate);

  if (
    policy.tenantId !== position.tenantId
    || policy.tenantId !== candidate.tenantId
    || policy.organizationId !== position.organizationId
    || policy.organizationId !== candidate.organizationId
  ) {
    throw new UsageMeteringError(
      'USAGE_BUDGET_SCOPE_MISMATCH',
      'Budget policy, position, and usage must share exact tenant and organization scope.',
    );
  }
  const currency = policy.currency.toUpperCase();
  if (
    position.currency.toUpperCase() !== currency
    || candidate.currency.toUpperCase() !== currency
  ) {
    throw new UsageMeteringError(
      'USAGE_BUDGET_CURRENCY_MISMATCH',
      'Budget policy, position, and usage must share one currency.',
    );
  }

  const projected =
    position.committedCostMinorUnits + candidate.costMinorUnits;
  const remaining = Math.max(
    policy.hardLimitMinorUnits - projected,
    0,
  );
  if (projected > policy.hardLimitMinorUnits) {
    return {
      status: 'DENY',
      reasonKey: 'HARD_LIMIT_EXCEEDED',
      projectedCostMinorUnits: projected,
      remainingHardLimitMinorUnits: remaining,
    };
  }
  if (
    policy.softLimitMinorUnits !== null
    && projected >= policy.softLimitMinorUnits
  ) {
    return {
      status: 'ALLOW_WITH_ALERT',
      reasonKey: 'SOFT_LIMIT_REACHED',
      projectedCostMinorUnits: projected,
      remainingHardLimitMinorUnits: remaining,
    };
  }
  return {
    status: 'ALLOW',
    projectedCostMinorUnits: projected,
    remainingHardLimitMinorUnits: remaining,
  };
}

function validatePolicy(policy: MonthlyUsageBudgetPolicy): void {
  if (
    !nonBlank(policy.policyKey)
    || !Number.isInteger(policy.version)
    || policy.version <= 0
    || !nonBlank(policy.tenantId)
    || (
      policy.organizationId !== null
      && !nonBlank(policy.organizationId)
    )
    || !validCurrency(policy.currency)
    || !Number.isInteger(policy.hardLimitMinorUnits)
    || policy.hardLimitMinorUnits < 0
    || (
      policy.softLimitMinorUnits !== null
      && (
        !Number.isInteger(policy.softLimitMinorUnits)
        || policy.softLimitMinorUnits < 0
        || policy.softLimitMinorUnits > policy.hardLimitMinorUnits
      )
    )
    || !validInstant(policy.effectiveFrom)
    || (
      policy.effectiveUntil !== null
      && (
        !validInstant(policy.effectiveUntil)
        || Date.parse(policy.effectiveUntil)
          <= Date.parse(policy.effectiveFrom)
      )
    )
  ) {
    throw new UsageMeteringError(
      'USAGE_POLICY_INVALID',
      'Usage budget policies require versioned scope, currency, bounded limits, and valid effective time.',
    );
  }
}

function validatePosition(position: UsageBudgetPosition): void {
  if (
    !nonBlank(position.tenantId)
    || (
      position.organizationId !== null
      && !nonBlank(position.organizationId)
    )
    || !validCurrency(position.currency)
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(position.period)
    || !Number.isInteger(position.committedCostMinorUnits)
    || position.committedCostMinorUnits < 0
  ) {
    throw new UsageMeteringError(
      'USAGE_POSITION_INVALID',
      'Usage positions require governed scope, YYYY-MM period, currency, and non-negative committed cost.',
    );
  }
}

function validCurrency(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value);
}

function validEvidence(references: readonly string[]): boolean {
  return references.length > 0
    && references.every((reference) => nonBlank(reference));
}

function nonBlank(value: string): boolean {
  return value.trim() !== '';
}

function validInstant(value: string): boolean {
  return nonBlank(value) && Number.isFinite(Date.parse(value));
}

export * from './repository.ts';
