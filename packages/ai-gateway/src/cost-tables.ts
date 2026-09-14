export interface AiTokenPrice {
  readonly inputPerMillionMinorUnits: number;
  readonly outputPerMillionMinorUnits: number;
}

const UNKNOWN: AiTokenPrice = {
  inputPerMillionMinorUnits: 50_000,
  outputPerMillionMinorUnits: 150_000,
};

const TABLE: Readonly<Record<string, AiTokenPrice>> = {
  'gpt-4o-mini': { inputPerMillionMinorUnits: 1_500, outputPerMillionMinorUnits: 6_000 },
  'gpt-4o': { inputPerMillionMinorUnits: 25_000, outputPerMillionMinorUnits: 100_000 },
  'text-embedding-3-small': { inputPerMillionMinorUnits: 200, outputPerMillionMinorUnits: 0 },
  'text-embedding-3-large': { inputPerMillionMinorUnits: 1_300, outputPerMillionMinorUnits: 0 },
  'gemini-2.0-flash': { inputPerMillionMinorUnits: 1_000, outputPerMillionMinorUnits: 4_000 },
  'gemini-embedding-001': { inputPerMillionMinorUnits: 1_500, outputPerMillionMinorUnits: 0 },
  'claude-sonnet-4-20250514': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },
  'claude-3-5-haiku-latest': { inputPerMillionMinorUnits: 8_000, outputPerMillionMinorUnits: 40_000 },
  'deepseek-chat': { inputPerMillionMinorUnits: 2_700, outputPerMillionMinorUnits: 11_000 },
  'deepseek-reasoner': { inputPerMillionMinorUnits: 5_500, outputPerMillionMinorUnits: 22_000 },
  'llama-3.1-8b-instant': { inputPerMillionMinorUnits: 500, outputPerMillionMinorUnits: 800 },
  'meta/llama-3.1-8b-instruct': { inputPerMillionMinorUnits: 0, outputPerMillionMinorUnits: 0 },
  'openrouter/auto': { inputPerMillionMinorUnits: 0, outputPerMillionMinorUnits: 0 },
  'mistral-small-latest': { inputPerMillionMinorUnits: 2_000, outputPerMillionMinorUnits: 6_000 },
  'grok-4': { inputPerMillionMinorUnits: 30_000, outputPerMillionMinorUnits: 150_000 },
};

export function lookupAiTokenPrice(modelKey: string): AiTokenPrice {
  const key = modelKey.trim().toLowerCase();
  for (const [name, price] of Object.entries(TABLE)) {
    if (name.toLowerCase() === key) return price;
  }
  for (const [name, price] of Object.entries(TABLE)) {
    if (key.startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(key)) return price;
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
  const cost = (inTok * price.inputPerMillionMinorUnits) / 1_000_000
    + (outTok * price.outputPerMillionMinorUnits) / 1_000_000;
  return Math.max(1, Math.ceil(cost));
}
