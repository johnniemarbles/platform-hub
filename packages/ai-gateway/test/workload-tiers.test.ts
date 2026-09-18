import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listWorkloadTier,
  providerSupportsEmbedding,
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
