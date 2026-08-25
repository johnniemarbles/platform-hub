import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommunicationProviderOutcome } from '../src/retry-policy.ts';

const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 };

test('accepts provider acceptance without retry', () => {
  assert.deepEqual(classifyCommunicationProviderOutcome({
    result: { status: 'ACCEPTED', reasonCode: 'OK' },
    currentAttempt: 0,
    policy,
  }), { action: 'ACCEPT', deliveryState: 'ACCEPTED' });
});

test('fails terminal provider rejection', () => {
  assert.deepEqual(classifyCommunicationProviderOutcome({
    result: { status: 'REJECTED', reasonCode: 'INVALID_RECIPIENT' },
    currentAttempt: 0,
    policy,
  }), { action: 'FAIL', deliveryState: 'FAILED', reasonCode: 'INVALID_RECIPIENT' });
});

test('retries retryable failures with bounded exponential/provider delay', () => {
  assert.deepEqual(classifyCommunicationProviderOutcome({
    result: { status: 'RETRYABLE_FAILURE', reasonCode: 'RATE_LIMITED', retryAfterMs: 5000 },
    currentAttempt: 0,
    policy,
  }), {
    action: 'RETRY',
    deliveryState: 'PENDING',
    delayMs: 5000,
    nextAttempt: 1,
    reasonCode: 'RATE_LIMITED',
  });
});

test('fails retryable outcomes when the next attempt reaches the limit', () => {
  assert.deepEqual(classifyCommunicationProviderOutcome({
    result: { status: 'RETRYABLE_FAILURE', reasonCode: 'PROVIDER_UNAVAILABLE' },
    currentAttempt: 2,
    policy,
  }), {
    action: 'FAIL',
    deliveryState: 'FAILED',
    reasonCode: 'PROVIDER_UNAVAILABLE',
  });
});

test('rejects invalid retry configuration', () => {
  assert.throws(
    () => classifyCommunicationProviderOutcome({
      result: { status: 'ACCEPTED', reasonCode: 'OK' },
      currentAttempt: 0,
      policy: { ...policy, maxAttempts: 0 },
    }),
    /COMMUNICATION_RETRY_MAX_ATTEMPTS_INVALID/,
  );
});
