import type { AiOperation } from './index.ts';
import { openaiCompatibleProvider } from './openai-compatible-catalog.ts';

export interface AiModelExecutionPolicy {
  readonly policyKey: string;
  readonly version: number;
  readonly providerKey: string;
  readonly generativeModelKey: string;
  readonly embeddingModelKey: string;
  readonly maximumInputCharacters: number;
  readonly maximumOutputTokens: number;
  readonly temperature: number;
}

export function defaultAiModelExecutionPolicy(provider: string): AiModelExecutionPolicy {
  const key = provider.trim().toLowerCase();
  if (key === 'openai') {
    return {
      policyKey: 'ai.model.openai.default', version: 1, providerKey: 'openai',
      generativeModelKey: 'gpt-4o-mini', embeddingModelKey: 'text-embedding-3-small',
      maximumInputCharacters: 50_000, maximumOutputTokens: 2_048, temperature: 0.7,
    };
  }
  if (key === 'anthropic') {
    return {
      policyKey: 'ai.model.anthropic.default', version: 1, providerKey: 'anthropic',
      generativeModelKey: 'claude-sonnet-5', embeddingModelKey: 'claude-sonnet-5',
      maximumInputCharacters: 50_000, maximumOutputTokens: 2_048, temperature: 0.7,
    };
  }
  const compat = openaiCompatibleProvider(key);
  if (compat) {
    return {
      policyKey: `ai.model.${compat.providerKey}.default`,
      version: 1,
      providerKey: compat.providerKey,
      generativeModelKey: compat.generativeModelKey,
      embeddingModelKey: compat.embeddingModelKey,
      maximumInputCharacters: 50_000,
      maximumOutputTokens: 2_048,
      temperature: 0.7,
    };
  }
  return {
    policyKey: 'ai.model.gemini.default', version: 1, providerKey: 'google-ai',
    generativeModelKey: 'gemini-2.0-flash', embeddingModelKey: 'gemini-embedding-001',
    maximumInputCharacters: 50_000, maximumOutputTokens: 2_048, temperature: 0.7,
  };
}

export function validateAiModelExecutionPolicy(
  policy: AiModelExecutionPolicy,
  providerKey: string,
): AiModelExecutionPolicy {
  const key = providerKey.toLowerCase();
  const compat = openaiCompatibleProvider(key) ?? openaiCompatibleProvider(policy.providerKey);
  const providerMatches = policy.providerKey === providerKey
    || (policy.providerKey === 'openai' && key.includes('openai'))
    || (policy.providerKey === 'google-ai' && /gemini|google-ai/u.test(key))
    || (policy.providerKey === 'anthropic' && key.includes('anthropic'))
    || (compat !== undefined && (policy.providerKey === compat.providerKey || key.includes(compat.providerKey)));
  const valid = policy.policyKey.trim() !== ''
    && Number.isInteger(policy.version) && policy.version > 0
    && providerMatches
    && policy.generativeModelKey.trim() !== ''
    && policy.embeddingModelKey.trim() !== ''
    && Number.isInteger(policy.maximumInputCharacters)
    && policy.maximumInputCharacters > 0 && policy.maximumInputCharacters <= 1_000_000
    && Number.isInteger(policy.maximumOutputTokens)
    && policy.maximumOutputTokens > 0 && policy.maximumOutputTokens <= 32_768
    && Number.isFinite(policy.temperature) && policy.temperature >= 0 && policy.temperature <= 2;
  if (!valid) throw new Error('AI_MODEL_EXECUTION_POLICY_INVALID');
  return policy;
}

export function modelForOperation(policy: AiModelExecutionPolicy, operation: AiOperation): string {
  return operation === 'EMBED' ? policy.embeddingModelKey : policy.generativeModelKey;
}

export function enforceAiInputLimit(policy: AiModelExecutionPolicy, input: string, context?: string): void {
  if (input.length + (context?.length ?? 0) > policy.maximumInputCharacters) {
    throw new Error('AI_MODEL_INPUT_LIMIT_EXCEEDED');
  }
}

export function requiresStructuredJson(operation: AiOperation): boolean {
  return operation === 'CLASSIFY' || operation === 'EXTRACT';
}

export function enforceStructuredAiOutput(operation: AiOperation, value: string): void {
  if (!requiresStructuredJson(operation)) return;
  try { JSON.parse(value); } catch { throw new Error('AI_STRUCTURED_OUTPUT_INVALID'); }
}
