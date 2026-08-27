import type { CommunicationPlane } from './plane.js';

/**
 * Design spec §3.1 step 13 and §4.2 — quota and throttle.
 *
 * PORTED PATTERN: BEMP's CommunicationThrottleService
 * (apps/core/src/communication/services/communication-throttle.service.ts,
 *  migration 0115_comms_distributed_throttle.sql).
 *
 * The atomic INSERT ... ON CONFLICT DO UPDATE counter inside a transaction is
 * proven correct under concurrent app instances. It is ported as-is and not
 * redesigned. The only change is the added `plane` key column (BEMP C14).
 *
 * "Consume" is the operative word. The slot is taken BEFORE the provider is
 * called. A counter read followed by a conditional is not a rate limit;
 * under two app instances it is a suggestion.
 */

export interface ThrottleLimits {
  readonly maxPerMinute: number;
  readonly maxPerDay: number;
}

export interface ThrottleConsumeRequest {
  readonly tenantId: string;
  readonly plane: CommunicationPlane;
  readonly limits: ThrottleLimits;
  readonly at?: Date;
}

export type ThrottleReasonCode =
  | 'THROTTLE_EXCEEDED_MINUTE'
  | 'THROTTLE_EXCEEDED_DAY'
  | 'PLANE_BUDGET';

export type ThrottleConsumeResult =
  | { readonly allowed: true; readonly minuteCount: number; readonly dayCount: number }
  | {
      readonly allowed: false;
      readonly reasonCode: ThrottleReasonCode;
      readonly minuteCount: number;
      readonly dayCount: number;
      readonly limit: number;
    };

/**
 * Implemented by the PostgreSQL adapter. The implementation MUST perform both
 * counter increments and both limit checks inside one transaction, and MUST
 * roll back when either limit is exceeded so a refused send does not burn a slot.
 */
export interface CommunicationThrottleRepository {
  consume(request: ThrottleConsumeRequest): Promise<ThrottleConsumeResult>;
  /** Advisory read for the usage dashboard. Never an enforcement path (§4). */
  peek(input: {
    readonly tenantId: string;
    readonly plane: CommunicationPlane;
    readonly at?: Date;
  }): Promise<{ readonly minuteCount: number; readonly dayCount: number }>;
}

/** BEMP uses ISO slices as window keys. Same scheme, same collision properties. */
export function minuteWindowKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 16);
}

export function dayWindowKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Pure evaluation, extracted so the limit arithmetic is unit-testable without
 * a database. The adapter applies this to the transform the transaction returned.
 */
export function evaluateThrottle(input: {
  readonly minuteCount: number;
  readonly dayCount: number;
  readonly limits: ThrottleLimits;
}): ThrottleConsumeResult {
  const maxPerMinute = Math.max(1, Math.floor(input.limits.maxPerMinute));
  const maxPerDay = Math.max(1, Math.floor(input.limits.maxPerDay));

  if (input.minuteCount > maxPerMinute) {
    return {
      allowed: false,
      reasonCode: 'THROTTLE_EXCEEDED_MINUTE',
      minuteCount: input.minuteCount,
      dayCount: input.dayCount,
      limit: maxPerMinute,
    };
  }
  if (input.dayCount > maxPerDay) {
    return {
      allowed: false,
      reasonCode: 'THROTTLE_EXCEEDED_DAY',
      minuteCount: input.minuteCount,
      dayCount: input.dayCount,
      limit: maxPerDay,
    };
  }
  return { allowed: true, minuteCount: input.minuteCount, dayCount: input.dayCount };
}

/**
 * §4.2 / B19 — spend caps.
 *
 * Deliberately separate from throttle: throttle bounds volume, the breaker
 * bounds money. A tenant can be well inside its message quota and still be
 * burning through a budget because it switched to a per-conversation channel.
 */
export type SpendBreakerState = 'CLOSED' | 'WARNING' | 'OPEN';

export interface SpendCapEvaluation {
  readonly state: SpendBreakerState;
  readonly allowed: boolean;
  readonly spentMinorUnits: number;
  readonly capMinorUnits: number | null;
  readonly utilisationPct: number;
}

export function evaluateSpendCap(input: {
  readonly spentMinorUnits: number;
  readonly capMinorUnits: number | null;
  readonly estimatedCostMinorUnits: number;
  readonly warningThresholdPct?: number;
}): SpendCapEvaluation {
  if (input.capMinorUnits === null) {
    return {
      state: 'CLOSED',
      allowed: true,
      spentMinorUnits: input.spentMinorUnits,
      capMinorUnits: null,
      utilisationPct: 0,
    };
  }

  const projected = input.spentMinorUnits + input.estimatedCostMinorUnits;
  const utilisationPct = Math.round((projected / input.capMinorUnits) * 1000) / 10;
  const warningAt = input.warningThresholdPct ?? 80;

  if (projected > input.capMinorUnits) {
    return {
      state: 'OPEN',
      allowed: false,
      spentMinorUnits: input.spentMinorUnits,
      capMinorUnits: input.capMinorUnits,
      utilisationPct,
    };
  }
  return {
    state: utilisationPct >= warningAt ? 'WARNING' : 'CLOSED',
    allowed: true,
    spentMinorUnits: input.spentMinorUnits,
    capMinorUnits: input.capMinorUnits,
    utilisationPct,
  };
}

export interface CommunicationSpendRepository {
  consume(input: {
    readonly tenantId: string;
    readonly estimatedCostMinorUnits: number;
    readonly at?: Date;
  }): Promise<SpendCapEvaluation>;
  read(tenantId: string): Promise<SpendCapEvaluation>;
}
