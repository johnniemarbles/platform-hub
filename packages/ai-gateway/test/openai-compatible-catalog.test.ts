import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  isGenerateLlmProvider,
  openaiCompatibleProvider,
  planningCapableProvider,
} from '../src/openai-compatible-catalog.ts';

test('catalog includes DeepSeek and NVIDIA free-tier NIM', () => {
  const deepseek = openaiCompatibleProvider('deepseek');
  const nvidia = openaiCompatibleProvider('nvidia');
  const nvidiaByok = openaiCompatibleProvider('nvidia-byok-5974');
  const deepseekByok = openaiCompatibleProvider('deepseek-byok-1234');
  assert.ok(deepseek);
  assert.ok(nvidia);
  assert.ok(nvidiaByok);
  assert.ok(deepseekByok);
  assert.equal(nvidia?.costTier, 'FREE_TIER');
  assert.equal(nvidiaByok?.providerKey, 'nvidia');
  assert.equal(deepseekByok?.providerKey, 'deepseek');
  assert.ok(OPENAI_COMPATIBLE_PROVIDERS.some((item) => item.providerKey === 'groq'));
});

test('generate provider recognition', () => {
  assert.equal(isGenerateLlmProvider('anthropic'), true);
  assert.equal(isGenerateLlmProvider('deepseek'), true);
  assert.equal(isGenerateLlmProvider('twilio'), false);
  assert.equal(planningCapableProvider('nvidia', 'llm'), true);
});
