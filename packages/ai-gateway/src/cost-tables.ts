/**
 * Provisional model pricing tables (USD minor units per 1M tokens).
 * Values are platform defaults for cost evidence and budget checks.
 * Tenants may override via connector/model policy in a later slice.
 *
 * 1 minor unit = $0.0001 (USD cents * 0.01 → use integer minor units).
 * Convention here: costMinorUnits are 1/100 of a US cent ($0.0001).
 */

export interface AiTokenPrice {
  readonly inputPerMillionMinorUnits: number;
  readonly outputPerMillionMinorUnits: number;
}

/** Default when model is unknown — intentionally conservative. */
const UNKNOWN: AiTokenPrice = {
  inputPerMillionMinorUnits: 50_000, // $5.00 / 1M
  outputPerMillionMinorUnits: 150_000,
};

const TABLE: Readonly<Record<string, AiTokenPrice>> = {
  // OpenAI
  'gpt-4o-mini': {
    inputPerMillionMinorUnits: 1_500, // $0.15
    outputPerMillionMinorUnits: 6_000, // $0.60
  },
  'gpt-4o': {
    inputPerMillionMinorUnits: 25_000,
    outputPerMillionMinorUnits: 100_000,
  },
  'text-embedding-3-small': {
    inputPerMillionMinorUnits: 200,
    outputPerMillionMinorUnits: 0,
  },
  'text-embedding-3-large': {
    inputPerMillionMinorUnits: 1_300,
    outputPerMillionMinorUnits: 0,
  },
  // Gemini
  'gemini-2.0-flash': {
    inputPerMillionMinorUnits: 1_000,
    outputPerMillionMinorUnits: 4_000,
  },
  'gemini-embedding-001': {
    inputPerMillionMinorUnits: 1_500,
    outputPerMillionMinorUnits: 0,
  },
  // Anthropic
  'claude-sonnet-4-20250514': {
    inputPerMillionMinorUnits: 30_000,
    outputPerMillionMinorUnits: 150_000,
  },
  'claude-3-5-haiku-latest': {
    inputPerMillionMinorUnits: 8_000,
    outputPerMillionMinorUnits: 40_000,
  },
};

export function lookupAiTokenPrice(modelKey: string): AiTokenPrice {
  const key = modelKey.trim().toLowerCase();
  for (const [name, price] of Object.entries(TABLE)) {
    if (name.toLowerCase() === key) return price;
  }
  // prefix match for dated model keys
  for (const [name, price] of Object.entries(TABLE)) {
    if (key.startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(key)) {
      return price;
    }
  }
  return UNKNOWN;
}

/**
 * Estimate cost in minor units from token counts and model key.
 * Always returns a non-negative integer; minimum 1 when any tokens used.
 */
export function estimateAiCostMinorUnits(input: {
  readonly modelKey: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}): number {
  const price = lookupAiTokenPrice(input.modelKey);
  const inTok = Math.max(0, Math.floor(input.inputTokens));
  const outTok = Math.max(0, Math.floor(input.outputTokens));
  if (inTok === 0 && outTok === 0) return 0;
  const cost =
    (inTok * price.inputPerMillionMinorUnits) / 1_000_000
    + (outTok * price.outputPerMillionMinorUnits) / 1_000_000;
  return Math.max(1, Math.ceil(cost));
}
