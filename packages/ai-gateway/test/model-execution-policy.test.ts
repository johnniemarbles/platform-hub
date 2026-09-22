import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultAiModelExecutionPolicy,
  enforceAiInputLimit,
  enforceStructuredAiOutput,
  modelForOperation,
  validateAiModelExecutionPolicy,
} from '../src/model-execution-policy.ts';

test('default policies version model selection and bound execution', () => {
  const openai = defaultAiModelExecutionPolicy('openai');
  assert.equal(modelForOperation(openai, 'GENERATE'), 'gpt-4o-mini');
  assert.equal(modelForOperation(openai, 'EMBED'), 'text-embedding-3-small');
  assert.equal(openai.version, 1);
  assert.ok(openai.maximumInputCharacters > 0);
  assert.ok(openai.maximumOutputTokens > 0);
  assert.equal(validateAiModelExecutionPolicy(openai, 'openai'), openai);
});

test('policy rejects provider mismatch and unbounded configuration', () => {
  const policy = defaultAiModelExecutionPolicy('openai');
  assert.throws(() => validateAiModelExecutionPolicy(policy, 'google-ai'), /AI_MODEL_EXECUTION_POLICY_INVALID/);
  assert.throws(() => validateAiModelExecutionPolicy({ ...policy, maximumOutputTokens: 0 }, 'openai'), /AI_MODEL_EXECUTION_POLICY_INVALID/);
});

test('input and structured-output guards fail closed', () => {
  const policy = { ...defaultAiModelExecutionPolicy('openai'), maximumInputCharacters: 5 };
  assert.throws(() => enforceAiInputLimit(policy, '1234', '56'), /AI_MODEL_INPUT_LIMIT_EXCEEDED/);
  assert.throws(() => enforceStructuredAiOutput('EXTRACT', 'not json'), /AI_STRUCTURED_OUTPUT_INVALID/);
  assert.doesNotThrow(() => enforceStructuredAiOutput('EXTRACT', '{"ok":true}'));
  assert.doesNotThrow(() => enforceStructuredAiOutput('GENERATE', 'free text'));
});
