export interface AiTokenPrice {
  readonly inputPerMillionMinorUnits: number;
  readonly outputPerMillionMinorUnits: number;
}

/** Conservative fallback when model is unknown (approx $5 / $15 per 1M). */
const UNKNOWN: AiTokenPrice = {
  inputPerMillionMinorUnits: 50_000,
  outputPerMillionMinorUnits: 150_000,
};

/**
 * Approximate public list prices in minor units where 10_000 minor units = $1.00
 * (i.e. 1 minor unit = $0.0001). Align keys with platform.ai_models model_key
 * values. Refresh when provider rate cards change; catalog migration owns
 * which models exist, this table owns cost estimation only.
 */
const TABLE: Readonly<Record<string, AiTokenPrice>> = {
  // OpenAI
  'gpt-5.1': { inputPerMillionMinorUnits: 12_500, outputPerMillionMinorUnits: 100_000 },
  'gpt-5.1-mini': { inputPerMillionMinorUnits: 2_500, outputPerMillionMinorUnits: 20_000 },
  'gpt-5': { inputPerMillionMinorUnits: 12_500, outputPerMillionMinorUnits: 100_000 },
  'gpt-5-mini': { inputPerMillionMinorUnits: 2_500, outputPerMillionMinorUnits: 20_000 },
  'gpt-5-nano': { inputPerMillionMinorUnits: 500, outputPerMillionMinorUnits: 4_000 },
  'gpt-4o-mini': { inputPerMillionMinorUnits: 1_500, outputPerMillionMinorUnits: 6_000 },
  'gpt-4o': { inputPerMillionMinorUnits: 25_000, outputPerMillionMinorUnits: 100_000 },
  'gpt-4o-audio-preview': { inputPerMillionMinorUnits: 25_000, outputPerMillionMinorUnits: 100_000 },
  'gpt-4o-realtime-preview': { inputPerMillionMinorUnits: 25_000, outputPerMillionMinorUnits: 100_000 },
  'gpt-4.1': { inputPerMillionMinorUnits: 20_000, outputPerMillionMinorUnits: 80_000 },
  'gpt-4.1-mini': { inputPerMillionMinorUnits: 4_000, outputPerMillionMinorUnits: 16_000 },
  'gpt-4.1-nano': { inputPerMillionMinorUnits: 1_000, outputPerMillionMinorUnits: 4_000 },
  'o3': { inputPerMillionMinorUnits: 20_000, outputPerMillionMinorUnits: 80_000 },
  'o3-mini': { inputPerMillionMinorUnits: 11_000, outputPerMillionMinorUnits: 44_000 },
  'o4-mini': { inputPerMillionMinorUnits: 11_000, outputPerMillionMinorUnits: 44_000 },
  'o4-mini-deep-research': { inputPerMillionMinorUnits: 11_000, outputPerMillionMinorUnits: 44_000 },
  'text-embedding-3-small': { inputPerMillionMinorUnits: 200, outputPerMillionMinorUnits: 0 },
  'text-embedding-3-large': { inputPerMillionMinorUnits: 1_300, outputPerMillionMinorUnits: 0 },

  // Anthropic
  'claude-sonnet-4-20250514': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },
  'claude-sonnet-5': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },
  'claude-opus-4-20250514': { inputPerMillionMinorUnits: 50_000, outputPerMillionMinorUnits: 250_000 },
  'claude-3-5-haiku-latest': { inputPerMillionMinorUnits: 8_000, outputPerMillionMinorUnits: 40_000 },
  'claude-haiku-4-5-20251001': { inputPerMillionMinorUnits: 10_000, outputPerMillionMinorUnits: 50_000 },

  // Google Gemini
  'gemini-2.0-flash': { inputPerMillionMinorUnits: 1_000, outputPerMillionMinorUnits: 4_000 },
  'gemini-2.5-flash': { inputPerMillionMinorUnits: 3_000, outputPerMillionMinorUnits: 25_000 },
  'gemini-2.5-pro': { inputPerMillionMinorUnits: 12_500, outputPerMillionMinorUnits: 100_000 },
  'gemini-3.6-flash': { inputPerMillionMinorUnits: 7_500, outputPerMillionMinorUnits: 37_500 },
  'gemini-embedding-001': { inputPerMillionMinorUnits: 1_500, outputPerMillionMinorUnits: 0 },

  // DeepSeek
  'deepseek-chat': { inputPerMillionMinorUnits: 2_700, outputPerMillionMinorUnits: 11_000 },
  'deepseek-reasoner': { inputPerMillionMinorUnits: 5_500, outputPerMillionMinorUnits: 22_000 },

  // Mistral
  'mistral-small-latest': { inputPerMillionMinorUnits: 2_000, outputPerMillionMinorUnits: 6_000 },
  'mistral-medium-latest': { inputPerMillionMinorUnits: 15_000, outputPerMillionMinorUnits: 75_000 },
  'mistral-large-latest': { inputPerMillionMinorUnits: 5_000, outputPerMillionMinorUnits: 15_000 },
  'ministral-8b-latest': { inputPerMillionMinorUnits: 1_500, outputPerMillionMinorUnits: 1_500 },
  'mistral-embed': { inputPerMillionMinorUnits: 1_000, outputPerMillionMinorUnits: 0 },

  // Meta / hosted Llama (representative hosts)
  'llama-3.1-8b-instant': { inputPerMillionMinorUnits: 500, outputPerMillionMinorUnits: 800 },
  'llama-3.3-70b-versatile': { inputPerMillionMinorUnits: 5_900, outputPerMillionMinorUnits: 7_900 },
  'meta/llama-3.1-8b-instruct': { inputPerMillionMinorUnits: 0, outputPerMillionMinorUnits: 0 },
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': { inputPerMillionMinorUnits: 1_800, outputPerMillionMinorUnits: 1_800 },
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': { inputPerMillionMinorUnits: 8_800, outputPerMillionMinorUnits: 8_800 },
  'accounts/fireworks/models/llama-v3p1-8b-instruct': { inputPerMillionMinorUnits: 2_000, outputPerMillionMinorUnits: 2_000 },
  'accounts/fireworks/models/nomic-embed-text-v1.5': { inputPerMillionMinorUnits: 160, outputPerMillionMinorUnits: 0 },
  'togethercomputer/m2-bert-80M-8k-retrieval': { inputPerMillionMinorUnits: 80, outputPerMillionMinorUnits: 0 },

  // xAI
  'grok-4': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },
  'grok-4-1': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },

  // Router / free-tier placeholders
  'openrouter/auto': { inputPerMillionMinorUnits: 0, outputPerMillionMinorUnits: 0 },
};

export function lookupAiTokenPrice(modelKey: string): AiTokenPrice {
  const key = modelKey.trim().toLowerCase();
  for (const [name, price] of Object.entries(TABLE)) {
    if (name.toLowerCase() === key) return price;
  }
  for (const [name, price] of Object.entries(TABLE)) {
    if (key.startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(key)) {
      return price;
    }
  }
  return UNKNOWN;
}

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
