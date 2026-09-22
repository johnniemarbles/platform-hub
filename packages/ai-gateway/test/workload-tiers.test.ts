import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listWorkloadTier,
  providerAllowedForWorkload,
  providerSupportsEmbedding,
  workloadProviderPolicyForTier,
  workloadTierForOperation,
} from '../src/workload-tiers.ts';

test('GENERATE is Brain tier', () => {
  const rec = workloadTierForOperation('GENERATE');
  assert.equal(rec.tier, 'BRAIN');
  assert.ok(rec.preferredProviderKeys.includes('openai'));
});

test('CLASSIFY is Utility tier', () => {
  const rec = workloadTierForOperation('CLASSIFY');
  assert.equal(rec.tier, 'UTILITY');
});

test('Brain workload policy is versioned and OpenAI only', () => {
  const policy = workloadProviderPolicyForTier('BRAIN');
  assert.equal(policy.policyKey, 'ai.workload.brain.openai-only');
  assert.equal(policy.version, 1);
  assert.equal(providerAllowedForWorkload('openai', 'BRAIN'), true);
  assert.equal(providerAllowedForWorkload('google-ai', 'BRAIN'), false);
  assert.equal(providerAllowedForWorkload('gemini', 'BRAIN'), false);
  assert.equal(providerAllowedForWorkload('anthropic', 'BRAIN'), false);
});

test('EMBED excludes Anthropic', () => {
  const rec = workloadTierForOperation('EMBED');
  assert.equal(rec.tier, 'EMBEDDING');
  assert.equal(providerSupportsEmbedding('anthropic'), false);
  assert.equal(providerSupportsEmbedding('openai'), true);
});

test('list covers all primary operations', () => {
  const ops = new Set(listWorkloadTier().map((r) => r.operation));
  assert.ok(ops.has('GENERATE'));
  assert.ok(ops.has('CLASSIFY'));
  assert.ok(ops.has('EMBED'));
  assert.ok(ops.has('VISION_ANALYZE'));
});
