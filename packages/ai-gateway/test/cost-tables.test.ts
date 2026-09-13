import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateAiCostMinorUnits,
  lookupAiTokenPrice,
} from '../src/cost-tables.ts';

test('lookup known openai mini pricing', () => {
  const price = lookupAiTokenPrice('gpt-4o-mini');
  assert.equal(price.inputPerMillionMinorUnits, 1500);
  assert.equal(price.outputPerMillionMinorUnits, 6000);
});

test('estimate cost uses ceiling and minimum 1', () => {
  const cost = estimateAiCostMinorUnits({
    modelKey: 'gpt-4o-mini',
    inputTokens: 1000,
    outputTokens: 500,
  });
  // (1000*1500 + 500*6000) / 1e6 = 1.5 + 3 = 4.5 → 5
  assert.equal(cost, 5);
});

test('unknown model uses conservative default', () => {
  const price = lookupAiTokenPrice('totally-unknown-model-xyz');
  assert.ok(price.inputPerMillionMinorUnits >= 10_000);
});

test('embedding-only cost', () => {
  const cost = estimateAiCostMinorUnits({
    modelKey: 'text-embedding-3-small',
    inputTokens: 10_000,
    outputTokens: 0,
  });
  // 10000 * 200 / 1e6 = 2
  assert.equal(cost, 2);
});
