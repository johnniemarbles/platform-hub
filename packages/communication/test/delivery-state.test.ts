import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDeliveryTransition,
  canApplyDeliveryTransition,
} from '../src/delivery-state.ts';

test('allows forward delivery progress and idempotent repeats', () => {
  assert.equal(canApplyDeliveryTransition('PENDING', 'ACCEPTED'), true);
  assert.equal(canApplyDeliveryTransition('ACCEPTED', 'SENT'), true);
  assert.equal(canApplyDeliveryTransition('SENT', 'DELIVERED'), true);
  assert.equal(canApplyDeliveryTransition('DELIVERED', 'DELIVERED'), true);
});

test('allows complaint after delivery but rejects delivery regressions', () => {
  assert.equal(canApplyDeliveryTransition('DELIVERED', 'COMPLAINED'), true);
  assert.equal(canApplyDeliveryTransition('DELIVERED', 'SENT'), false);
  assert.equal(canApplyDeliveryTransition('FAILED', 'ACCEPTED'), false);
});

test('assertDeliveryTransition fails closed for invalid transitions', () => {
  assert.throws(
    () => assertDeliveryTransition('BOUNCED', 'DELIVERED'),
    /COMMUNICATION_DELIVERY_TRANSITION_INVALID:BOUNCED->DELIVERED/,
  );
});
