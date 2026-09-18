import type { AiOperation } from './index.ts';

/**
 * Soft recommendation tiers for Brand capability defaults.
 * Brain = high-reasoning / agentic / editorial paths.
 * Utility = high-volume classify / extract / embed / background.
 * Brands may override; this is UI guidance only, not hard routing policy.
 */
export type AiWorkloadTier = 'BRAIN' | 'UTILITY' | 'EMBEDDING' | 'VISION';

export interface WorkloadTierRecommendation {
  readonly operation: AiOperation;
  readonly tier: AiWorkloadTier;
  readonly preferredProviderKeys: readonly string[];
  readonly preferredModelKeyHints: readonly string[];
  readonly rationale: string;
}

const TABLE: readonly WorkloadTierRecommendation[] = [
  {
    operation: 'GENERATE',
    tier: 'BRAIN',
    preferredProviderKeys: ['openai', 'anthropic'],
    preferredModelKeyHints: ['gpt-4o', 'gpt-4.1', 'claude-sonnet', 'claude-opus'],
    rationale: 'Complex reasoning, agentic workflows, and strict JSON formatting.',
  },
  {
    operation: 'SUMMARIZE',
    tier: 'BRAIN',
    preferredProviderKeys: ['openai', 'anthropic', 'gemini', 'google-ai'],
    preferredModelKeyHints: ['gpt-4o', 'claude-sonnet', 'gemini-2.5-pro'],
    rationale: 'Quality-sensitive synthesis; still Brain-class unless volume forces Utility.',
  },
  {
    operation: 'CLASSIFY',
    tier: 'UTILITY',
    preferredProviderKeys: ['gemini', 'google-ai', 'anthropic', 'deepseek', 'mistral'],
    preferredModelKeyHints: ['gemini-2.0-flash', 'gemini-2.5-flash', 'claude-haiku', 'deepseek-chat', 'mistral-small'],
    rationale: 'High-throughput routing/sentiment; optimize TTFT and cost.',
  },
  {
    operation: 'EXTRACT',
    tier: 'UTILITY',
    preferredProviderKeys: ['gemini', 'google-ai', 'openai', 'deepseek'],
    preferredModelKeyHints: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gpt-4o-mini', 'deepseek-chat'],
    rationale: 'Long-context document/entity extraction; prefer large context + low cost.',
  },
  {
    operation: 'TRANSLATE',
    tier: 'UTILITY',
    preferredProviderKeys: ['gemini', 'google-ai', 'openai', 'mistral'],
    preferredModelKeyHints: ['gemini-2.0-flash', 'gpt-4o-mini', 'mistral-small'],
    rationale: 'Volume translation benefits from Utility-tier pricing.',
  },
  {
    operation: 'EMBED',
    tier: 'EMBEDDING',
    preferredProviderKeys: ['openai', 'gemini', 'google-ai', 'mistral'],
    preferredModelKeyHints: ['text-embedding-3-large', 'text-embedding-3-small', 'gemini-embedding-001', 'mistral-embed'],
    rationale: 'Anthropic has no native embedding model; map Embed only to providers that do.',
  },
  {
    operation: 'RERANK',
    tier: 'UTILITY',
    preferredProviderKeys: ['openai', 'cohere'],
    preferredModelKeyHints: ['gpt-4o-mini'],
    rationale: 'Retrieval re-ranking is high-volume Utility work when not using a dedicated reranker.',
  },
  {
    operation: 'VISION_ANALYZE',
    tier: 'VISION',
    preferredProviderKeys: ['openai', 'gemini', 'google-ai', 'google-vision', 'aws-textract'],
    preferredModelKeyHints: ['gpt-4o', 'gemini-2.5-flash'],
    rationale: 'Multimodal vision / OCR path; provider-specific adapters apply.',
  },
];

export function workloadTierForOperation(operation: AiOperation): WorkloadTierRecommendation {
  const found = TABLE.find((row) => row.operation === operation);
  if (found === undefined) {
    return {
      operation,
      tier: 'UTILITY',
      preferredProviderKeys: ['openai', 'gemini', 'google-ai'],
      preferredModelKeyHints: [],
      rationale: 'Default Utility tier for unlisted operations.',
    };
  }
  return found;
}

export function listWorkloadTier(): readonly WorkloadTierRecommendation[] {
  return TABLE;
}

/** True when the provider is known not to offer native embeddings. */
export function providerSupportsEmbedding(providerKey: string): boolean {
  const key = providerKey.trim().toLowerCase();
  if (key.includes('anthropic')) return false;
  return true;
}
