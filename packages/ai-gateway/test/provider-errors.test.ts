import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiProviderError,
  classifyAiProviderStatus,
  safeAiFailure,
} from '../src/provider-errors.ts';

test('provider status classification separates retryable and terminal failures', () => {
  assert.equal(classifyAiProviderStatus('openai', 401).retryable, false);
  assert.equal(classifyAiProviderStatus('openai', 429).retryable, true);
  assert.equal(classifyAiProviderStatus('openai', 503).retryable, true);
  assert.equal(classifyAiProviderStatus('openai', 422).retryable, false);
});

test('safe failure metadata never includes arbitrary upstream text', () => {
  const provider = safeAiFailure(new AiProviderError({
    code: 'AI_PROVIDER_RATE_LIMITED', providerKey: 'gemini', httpStatus: 429, retryable: true,
  }));
  assert.deepEqual(provider, {
    code: 'AI_PROVIDER_RATE_LIMITED',
    reason: 'AI_PROVIDER_RATE_LIMITED: gemini provider request failed.',
    retryable: true,
  });

  const unknown = safeAiFailure(new Error('database exploded with SENSITIVE payload'));
  assert.equal(unknown.code, 'AI_EXECUTION_FAILED');
  assert.doesNotMatch(unknown.reason, /database|SENSITIVE|payload/);
});
