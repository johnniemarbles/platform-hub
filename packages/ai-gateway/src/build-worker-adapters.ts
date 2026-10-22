import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import {
  AnthropicAiAdapter,
  AwsTextractAdapter,
  GeminiAiAdapter,
  GoogleVisionAdapter,
  OpenAiAiAdapter,
  OpenAiRerankAdapter,
  OpenAiVisionAdapter,
  openaiCompatibleProvider,
  type AiApiTokenProvider,
  type AiOperation,
  type AiProviderAdapter,
} from './index.ts';

export interface BuildAiWorkerAdaptersInput {
  readonly connectors: readonly ConnectorDefinition[];
  readonly operation: AiOperation;
  readonly apiToken: AiApiTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now: () => string;
  readonly requestTimeoutMs: number;
}

function adapterKind(connector: {
  readonly providerType: string;
  readonly providerKey: string;
}): 'openai' | 'gemini' | 'anthropic' | 'google-vision' | 'aws-textract' | 'openai-compat' | null {
  const value = `${connector.providerType}:${connector.providerKey}`.toLowerCase();
  if (value.includes('textract') || value.includes('aws-textract')) return 'aws-textract';
  if (value.includes('google-vision') || value.includes('cloud-vision')) return 'google-vision';
  if (value.includes('openai')) return 'openai';
  if (value.includes('gemini') || value.includes('google-ai')) return 'gemini';
  if (value.includes('anthropic')) return 'anthropic';
  if (openaiCompatibleProvider(connector.providerKey) || openaiCompatibleProvider(connector.providerType)) {
    return 'openai-compat';
  }
  return null;
}

export function buildAiWorkerAdapters(
  input: BuildAiWorkerAdaptersInput,
): Map<string, AiProviderAdapter> {
  const adapters = new Map<string, AiProviderAdapter>();
  const common = {
    apiToken: input.apiToken,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    now: input.now,
    requestTimeoutMs: input.requestTimeoutMs,
  };
  for (const connector of input.connectors) {
    const kind = adapterKind(connector);
    if (kind === 'aws-textract') {
      if (input.operation === 'VISION_ANALYZE') {
        adapters.set(connector.connectorKey, new AwsTextractAdapter(common));
      }
    } else if (kind === 'google-vision') {
      if (input.operation === 'VISION_ANALYZE') {
        adapters.set(connector.connectorKey, new GoogleVisionAdapter(common));
      }
    } else if (kind === 'openai') {
      if (input.operation === 'RERANK') {
        adapters.set(connector.connectorKey, new OpenAiRerankAdapter(common));
      } else if (input.operation === 'VISION_ANALYZE') {
        adapters.set(connector.connectorKey, new OpenAiVisionAdapter(common));
      } else {
        adapters.set(connector.connectorKey, new OpenAiAiAdapter(common));
      }
    } else if (kind === 'openai-compat') {
      const compat = openaiCompatibleProvider(connector.providerKey)
        ?? openaiCompatibleProvider(connector.providerType);
      if (!compat) continue;
      if (input.operation === 'VISION_ANALYZE') continue;
      adapters.set(connector.connectorKey, new OpenAiAiAdapter({
        ...common,
        endpointBaseUrl: compat.endpointBaseUrl,
        modelKey: input.operation === 'EMBED' ? compat.embeddingModelKey : compat.generativeModelKey,
      }));
    } else if (kind === 'gemini') {
      adapters.set(connector.connectorKey, new GeminiAiAdapter(common));
    } else if (kind === 'anthropic') {
      adapters.set(connector.connectorKey, new AnthropicAiAdapter(common));
    }
  }
  return adapters;
}

export const DURABLE_AI_OPERATIONS = new Set<AiOperation>([
  'GENERATE',
  'CLASSIFY',
  'SUMMARIZE',
  'EXTRACT',
  'TRANSLATE',
  'EMBED',
  'RERANK',
  'VISION_ANALYZE',
]);

export function durableAiArtifactKind(
  op: AiOperation,
): 'AI_EMBEDDING' | 'AI_TEXT' {
  return op === 'EMBED' ? 'AI_EMBEDDING' : 'AI_TEXT';
}
