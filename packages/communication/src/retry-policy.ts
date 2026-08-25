import type { CommunicationProviderSendResult } from './provider-adapter.ts';

export interface CommunicationRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type CommunicationProviderOutcomeDecision =
  | {
      readonly action: 'ACCEPT';
      readonly deliveryState: 'ACCEPTED';
    }
  | {
      readonly action: 'FAIL';
      readonly deliveryState: 'FAILED';
      readonly reasonCode: string;
    }
  | {
      readonly action: 'RETRY';
      readonly deliveryState: 'PENDING';
      readonly delayMs: number;
      readonly nextAttempt: number;
      readonly reasonCode: string;
    };

export function classifyCommunicationProviderOutcome(input: {
  readonly result: CommunicationProviderSendResult;
  readonly currentAttempt: number;
  readonly policy: CommunicationRetryPolicy;
}): CommunicationProviderOutcomeDecision {
  if (!Number.isInteger(input.policy.maxAttempts) || input.policy.maxAttempts < 1) {
    throw new Error('COMMUNICATION_RETRY_MAX_ATTEMPTS_INVALID');
  }
  if (input.result.status === 'ACCEPTED') {
    return { action: 'ACCEPT', deliveryState: 'ACCEPTED' };
  }
  if (input.result.status === 'REJECTED') {
    return {
      action: 'FAIL',
      deliveryState: 'FAILED',
      reasonCode: input.result.reasonCode,
    };
  }

  const nextAttempt = input.currentAttempt + 1;
  if (nextAttempt >= input.policy.maxAttempts) {
    return {
      action: 'FAIL',
      deliveryState: 'FAILED',
      reasonCode: input.result.reasonCode,
    };
  }

  const exponential = input.policy.baseDelayMs * (2 ** Math.max(0, input.currentAttempt));
  const providerDelay = input.result.retryAfterMs ?? 0;
  return {
    action: 'RETRY',
    deliveryState: 'PENDING',
    delayMs: Math.min(input.policy.maxDelayMs, Math.max(exponential, providerDelay)),
    nextAttempt,
    reasonCode: input.result.reasonCode,
  };
}
