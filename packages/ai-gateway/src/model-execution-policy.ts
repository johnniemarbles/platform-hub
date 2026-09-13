import type { AiOperation } from './index.ts';

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

export function defaultAiModelExecutionPolicy(
  provider: 'openai' | 'gemini',
): AiModelExecutionPolicy {
  return provider === 'openai'
    ? {
        policyKey: 'ai.model.openai.default', version: 1, providerKey: 'openai',
        generativeModelKey: 'gpt-4o-mini', embeddingModelKey: 'text-embedding-3-small',
        maximumInputCharacters: 50_000, maximumOutputTokens: 2_048, temperature: 0.7,
      }
    : {
        policyKey: 'ai.model.gemini.default', version: 1, providerKey: 'google-ai',
        generativeModelKey: 'gemini-2.0-flash', embeddingModelKey: 'gemini-embedding-001',
        maximumInputCharacters: 50_000, maximumOutputTokens: 2_048, temperature: 0.7,
      };
}

export function validateAiModelExecutionPolicy(
  policy: AiModelExecutionPolicy,
  providerKey: string,
): AiModelExecutionPolicy {
  const providerMatches = policy.providerKey === providerKey
    || (policy.providerKey === 'openai' && providerKey.toLowerCase().includes('openai'))
    || (policy.providerKey === 'google-ai' && /gemini|google-ai/u.test(providerKey.toLowerCase()));
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

export function modelForOperation(
  policy: AiModelExecutionPolicy,
  operation: AiOperation,
): string {
  return operation === 'EMBED' ? policy.embeddingModelKey : policy.generativeModelKey;
}

export function enforceAiInputLimit(
  policy: AiModelExecutionPolicy,
  input: string,
  context?: string,
): void {
  if (input.length + (context?.length ?? 0) > policy.maximumInputCharacters) {
    throw new Error('AI_MODEL_INPUT_LIMIT_EXCEEDED');
  }
}

export function requiresStructuredJson(operation: AiOperation): boolean {
  return operation === 'CLASSIFY' || operation === 'EXTRACT';
}

export function enforceStructuredAiOutput(operation: AiOperation, value: string): void {
  if (!requiresStructuredJson(operation)) return;
  try {
    JSON.parse(value);
  } catch {
    throw new Error('AI_STRUCTURED_OUTPUT_INVALID');
  }
}
