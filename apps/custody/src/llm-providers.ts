/**
 * Local inline of the GenerateLLM provider list from expadio's @expadio/ai-gateway.
 *
 * Custody uses this to decide whether an incoming provider key is a supported
 * LLM for the intake flow. When the full ai-gateway package is extracted into
 * the hub, this file becomes a re-export from it and this standalone shape
 * goes away.
 *
 * The lists mirror expadio's packages/ai-gateway/src/openai-compatible-catalog.ts
 * at commit b2c2811. Keep in sync until the full gateway lands.
 */

const NATIVE_LLM_PROVIDERS: readonly string[] = [
  'openai', 'gemini', 'google-ai', 'anthropic',
];

const OPENAI_COMPATIBLE_PROVIDER_KEYS: readonly string[] = [
  'deepseek', 'nvidia', 'openrouter', 'groq', 'together', 'fireworks', 'cerebras', 'perplexity',
  'mistral', 'xai', 'moonshot', 'cohere',
];

export function isGenerateLlmProvider(providerKey: string): boolean {
  const key = providerKey.trim().toLowerCase();
  if (NATIVE_LLM_PROVIDERS.includes(key)) return true;
  return OPENAI_COMPATIBLE_PROVIDER_KEYS.some((item) => key.includes(item));
}
