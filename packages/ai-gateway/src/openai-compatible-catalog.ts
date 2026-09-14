export type LlmCostTier = 'FREE_TIER' | 'LOW_COST' | 'STANDARD';

export interface OpenAiCompatibleProvider {
  readonly providerKey: string;
  readonly displayName: string;
  readonly endpointBaseUrl: string;
  readonly modelsPath: string;
  readonly generativeModelKey: string;
  readonly embeddingModelKey: string;
  readonly costTier: LlmCostTier;
  readonly notes: string;
  readonly docsUrl: string;
  readonly keysUrl: string;
}

export const OPENAI_COMPATIBLE_PROVIDERS: readonly OpenAiCompatibleProvider[] = [
  {
    providerKey: 'deepseek',
    displayName: 'DeepSeek',
    endpointBaseUrl: 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    generativeModelKey: 'deepseek-chat',
    embeddingModelKey: 'deepseek-chat',
    costTier: 'LOW_COST',
    notes: 'OpenAI-compatible. Very low token price; strong reasoning via deepseek-reasoner.',
    docsUrl: 'https://api-docs.deepseek.com/',
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    providerKey: 'nvidia',
    displayName: 'NVIDIA NIM',
    endpointBaseUrl: 'https://integrate.api.nvidia.com/v1',
    modelsPath: '/models',
    generativeModelKey: 'meta/llama-3.1-8b-instruct',
    embeddingModelKey: 'nvidia/nv-embedqa-e5-v5',
    costTier: 'FREE_TIER',
    notes: 'Build.nvidia.com API keys include a free credit pool for hosted NIM models.',
    docsUrl: 'https://docs.api.nvidia.com/nim/',
    keysUrl: 'https://build.nvidia.com/settings/api-keys',
  },
  {
    providerKey: 'groq',
    displayName: 'Groq',
    endpointBaseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    generativeModelKey: 'llama-3.1-8b-instant',
    embeddingModelKey: 'llama-3.1-8b-instant',
    costTier: 'FREE_TIER',
    notes: 'High-speed inference with a documented free daily quota.',
    docsUrl: 'https://console.groq.com/docs/openai',
    keysUrl: 'https://console.groq.com/keys',
  },
  {
    providerKey: 'together',
    displayName: 'Together AI',
    endpointBaseUrl: 'https://api.together.xyz/v1',
    modelsPath: '/models',
    generativeModelKey: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    embeddingModelKey: 'togethercomputer/m2-bert-80M-8k-retrieval',
    costTier: 'FREE_TIER',
    notes: 'Open-weight hosting; new accounts typically receive starter credits.',
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    keysUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    providerKey: 'fireworks',
    displayName: 'Fireworks',
    endpointBaseUrl: 'https://api.fireworks.ai/inference/v1',
    modelsPath: '/models',
    generativeModelKey: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    embeddingModelKey: 'accounts/fireworks/models/nomic-embed-text-v1.5',
    costTier: 'LOW_COST',
    notes: 'OpenAI-compatible serverless inference.',
    docsUrl: 'https://docs.fireworks.ai/guides/querying-text-models',
    keysUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    providerKey: 'openrouter',
    displayName: 'OpenRouter',
    endpointBaseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    generativeModelKey: 'openrouter/auto',
    embeddingModelKey: 'openrouter/auto',
    costTier: 'FREE_TIER',
    notes: 'Router across many vendors. Prefer :free model slugs for zero-charge routes.',
    docsUrl: 'https://openrouter.ai/docs',
    keysUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    providerKey: 'mistral',
    displayName: 'Mistral',
    endpointBaseUrl: 'https://api.mistral.ai/v1',
    modelsPath: '/models',
    generativeModelKey: 'mistral-small-latest',
    embeddingModelKey: 'mistral-embed',
    costTier: 'LOW_COST',
    notes: 'Experiment / trial keys available on the Mistral console.',
    docsUrl: 'https://docs.mistral.ai/api/',
    keysUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    providerKey: 'xai',
    displayName: 'xAI',
    endpointBaseUrl: 'https://api.x.ai/v1',
    modelsPath: '/models',
    generativeModelKey: 'grok-4',
    embeddingModelKey: 'grok-4',
    costTier: 'STANDARD',
    notes: 'OpenAI-compatible Grok API.',
    docsUrl: 'https://docs.x.ai/docs',
    keysUrl: 'https://console.x.ai/',
  },
];

export const NATIVE_LLM_PROVIDERS = [
  'openai',
  'gemini',
  'google-ai',
  'anthropic',
] as const;

export function openaiCompatibleProvider(
  providerKey: string,
): OpenAiCompatibleProvider | undefined {
  const key = providerKey.trim().toLowerCase();
  return OPENAI_COMPATIBLE_PROVIDERS.find((item) => item.providerKey === key);
}

export function isGenerateLlmProvider(providerKey: string): boolean {
  const key = providerKey.trim().toLowerCase();
  return (
    (NATIVE_LLM_PROVIDERS as readonly string[]).includes(key)
    || openaiCompatibleProvider(key) !== undefined
  );
}

export function allGenerateProviderKeys(): readonly string[] {
  return [
    ...NATIVE_LLM_PROVIDERS,
    ...OPENAI_COMPATIBLE_PROVIDERS.map((item) => item.providerKey),
  ];
}

export function planningCapableProvider(providerKey: string, providerType = ''): boolean {
  const value = `${providerType}:${providerKey}`.toLowerCase();
  return (
    value.includes('openai')
    || value.includes('gemini')
    || value.includes('google-ai')
    || value.includes('anthropic')
    || OPENAI_COMPATIBLE_PROVIDERS.some((item) => value.includes(item.providerKey))
  );
}
