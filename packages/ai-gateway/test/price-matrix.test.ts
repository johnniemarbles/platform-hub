import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAiModelPrice } from '../src/price-matrix.ts';

test('resolveAiModelPrice prefers latest effective matrix row', () => {
  const price = resolveAiModelPrice(
    [
      {
        modelKey: 'gpt-4o-mini',
        matrixVersion: '2026-01-01',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveUntil: null,
        inputPerMillionMinorUnits: 1_000,
        outputPerMillionMinorUnits: 4_000,
        currency: 'USD',
      },
      {
        modelKey: 'gpt-4o-mini',
        matrixVersion: '2026-09-18',
        effectiveFrom: '2026-09-18T00:00:00.000Z',
        effectiveUntil: null,
        inputPerMillionMinorUnits: 1_500,
        outputPerMillionMinorUnits: 6_000,
        currency: 'USD',
      },
    ],
    'gpt-4o-mini',
    '2026-09-18T12:00:00.000Z',
  );
  assert.equal(price.source, 'matrix');
  assert.equal(price.matrixVersion, '2026-09-18');
  assert.equal(price.inputPerMillionMinorUnits, 1_500);
});

test('resolveAiModelPrice falls back to cost-tables', () => {
  const price = resolveAiModelPrice([], 'gpt-4o-mini');
  assert.equal(price.source, 'cost-tables');
  assert.equal(price.matrixVersion, null);
  assert.ok(price.inputPerMillionMinorUnits > 0);
});
