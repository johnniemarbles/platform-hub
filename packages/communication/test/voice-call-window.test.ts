import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateVoiceCallWindow } from '../src/voice-call-window.ts';

test('India: 10:30 IST is inside hours, 21:30 IST is outside', () => {
  assert.equal(evaluateVoiceCallWindow('+919800000001', new Date('2026-09-26T05:00:00Z')).allowed, true);
  const late = evaluateVoiceCallWindow('+919800000001', new Date('2026-09-26T16:00:00Z'));
  assert.equal(late.allowed, false);
  assert.match(late.localTime, /^21:30 Asia\/Kolkata$/);
});

test('North America must be within hours in every mainland zone', () => {
  // 17:00 UTC = 13:00 New York, 10:00 Los Angeles -> allowed.
  assert.equal(evaluateVoiceCallWindow('+14155550100', new Date('2026-09-26T17:00:00Z')).allowed, true);
  // 14:30 UTC = 10:30 New York but 07:30 Los Angeles -> refused.
  const early = evaluateVoiceCallWindow('+12125550100', new Date('2026-09-26T14:30:00Z'));
  assert.equal(early.allowed, false);
  assert.match(early.localTime, /Denver|Los_Angeles/);
});

test('longest country code wins and unknown countries are not guessed', () => {
  assert.match(evaluateVoiceCallWindow('+971500000000', new Date('2026-09-26T06:00:00Z')).localTime, /Dubai/);
  const unknown = evaluateVoiceCallWindow('+99912345678', new Date('2026-09-26T06:00:00Z'));
  assert.deepEqual([unknown.known, unknown.allowed], [false, true]);
});
