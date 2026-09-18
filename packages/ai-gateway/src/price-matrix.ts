import type { AiTokenPrice } from './cost-tables.ts';
import { lookupAiTokenPrice } from './cost-tables.ts';

export interface AiModelPriceRow {
  readonly modelKey: string;
  readonly matrixVersion: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly inputPerMillionMinorUnits: number;
  readonly outputPerMillionMinorUnits: number;
  readonly currency: string;
}

/**
 * Resolve price from a versioned matrix snapshot as-of a point in time.
 * Falls back to in-process cost-tables when no row matches.
 */
export function resolveAiModelPrice(
  rows: readonly AiModelPriceRow[],
  modelKey: string,
  asOfIso: string = new Date().toISOString(),
): AiTokenPrice & { readonly matrixVersion: string | null; readonly source: 'matrix' | 'cost-tables' } {
  const key = modelKey.trim().toLowerCase();
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) {
    throw new Error('AI_PRICE_AS_OF_INVALID');
  }

  const candidates = rows
    .filter((row) => row.modelKey.trim().toLowerCase() === key)
    .filter((row) => {
      const from = Date.parse(row.effectiveFrom);
      if (!Number.isFinite(from) || from > asOf) return false;
      if (row.effectiveUntil === null) return true;
      const until = Date.parse(row.effectiveUntil);
      return Number.isFinite(until) && until > asOf;
    })
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));

  const hit = candidates[0];
  if (hit) {
    return {
      inputPerMillionMinorUnits: hit.inputPerMillionMinorUnits,
      outputPerMillionMinorUnits: hit.outputPerMillionMinorUnits,
      matrixVersion: hit.matrixVersion,
      source: 'matrix',
    };
  }

  const fallback = lookupAiTokenPrice(modelKey);
  return {
    ...fallback,
    matrixVersion: null,
    source: 'cost-tables',
  };
}
