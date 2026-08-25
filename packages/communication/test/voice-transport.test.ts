import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVoiceCallTransition } from '../src/voice-transport.ts';

test('allows normal outbound voice lifecycle transitions', () => {
  assert.doesNotThrow(() => assertVoiceCallTransition('REQUESTED', 'RINGING'));
  assert.doesNotThrow(() => assertVoiceCallTransition('RINGING', 'ANSWERED'));
  assert.doesNotThrow(() => assertVoiceCallTransition('ANSWERED', 'COMPLETED'));
});

test('allows terminal failure and cancellation before answer', () => {
  assert.doesNotThrow(() => assertVoiceCallTransition('REQUESTED', 'FAILED'));
  assert.doesNotThrow(() => assertVoiceCallTransition('RINGING', 'CANCELLED'));
});

test('rejects terminal-state regression', () => {
  assert.throws(
    () => assertVoiceCallTransition('COMPLETED', 'ANSWERED'),
    /VOICE_CALL_TRANSITION_INVALID:COMPLETED->ANSWERED/,
  );
});

test('treats repeated identical provider state as idempotent', () => {
  assert.doesNotThrow(() => assertVoiceCallTransition('ANSWERED', 'ANSWERED'));
});
