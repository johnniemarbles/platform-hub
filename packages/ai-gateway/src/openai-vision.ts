import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { AiInvocationIntent, AiProposal, AiProvenance } from './index.ts';
import type { AiProviderAdapter } from './routing.ts';
import type { AiApiTokenProvider } from './gemini-adapter.ts';
import { fetchAiProvider } from './provider-errors.ts';
import { estimateAiCostMinorUnits } from './cost-tables.ts';
import {
  defaultAiModelExecutionPolicy,
  enforceAiInputLimit,
  validateAiModelExecutionPolicy,
  type AiModelExecutionPolicy,
} from './model-execution-policy.ts';

export interface OpenAiVisionAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly executionPolicy?: AiModelExecutionPolicy;
  /** Defaults to gpt-4o when not overridden by policy generative model. */
  readonly visionModelKey?: string;
}

/**
 * OpenAI multimodal VISION_ANALYZE.
 *
 * Intent inputReference JSON:
 * {
 *   "prompt": string,
 *   "images": Array<
 *     | { "mediaType": string, "dataBase64": string }
 *     | { "url": string }
 *   >
 * }
 *
 * Observation only — never mutates business state.
 */
export class OpenAiVisionAdapter implements AiProviderAdapter {
  readonly adapterKey = 'openai-vision-v1';
  readonly #apiToken: AiApiTokenProvider;
  readonly #executionPolicy: AiModelExecutionPolicy;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;
  readonly #visionModelKey: string;

  constructor(options: OpenAiVisionAdapterOptions) {
    this.#apiToken = options.apiToken;
    const fallback = defaultAiModelExecutionPolicy('openai');
    this.#executionPolicy = validateAiModelExecutionPolicy(
      options.executionPolicy ?? fallback,
      'openai',
    );
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs);
    this.#visionModelKey =
      options.visionModelKey
      ?? this.#executionPolicy.generativeModelKey
      ?? 'gpt-4o';
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    if (intent.operation !== 'VISION_ANALYZE') {
      throw new Error(
        `AI_OPERATION_UNSUPPORTED: OpenAiVisionAdapter only supports VISION_ANALYZE, got ${intent.operation}`,
      );
    }

    enforceAiInputLimit(this.#executionPolicy, intent.inputReference, intent.contextReference);
    const processedAt = this.#now();
    const parsed = parseVisionInput(intent.inputReference);

    const token = await this.#apiToken({
      tenantId: intent.tenantId,
      connectorKey: connector.connectorKey,
      operation: intent.operation,
      purpose: intent.purpose,
      idempotencyKey: intent.idempotencyKey,
      requestedAt: intent.requestedAt,
    });
    if (!token || token.trim() === '') {
      throw new Error('AI_CREDENTIAL_UNAVAILABLE: Leased token is empty');
    }

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: parsed.prompt },
    ];
    for (const image of parsed.images) {
      if ('url' in image) {
        content.push({
          type: 'image_url',
          image_url: { url: image.url },
        });
      } else {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${image.mediaType};base64,${image.dataBase64}`,
          },
        });
      }
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    if (intent.contextReference) {
      messages.push({ role: 'system', content: intent.contextReference });
    }
    messages.push({ role: 'user', content });

    const response = await fetchAiProvider(
      connector.providerKey,
      this.#fetch,
      `${this.#endpointBaseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'expadio-ai-gateway/1.0',
        },
        body: JSON.stringify({
          model: this.#visionModelKey,
          temperature: this.#executionPolicy.temperature,
          max_tokens: this.#executionPolicy.maximumOutputTokens,
          messages,
        }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      },
    );

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const generatedText = data.choices?.[0]?.message?.content ?? '';
    if (generatedText.trim() === '') {
      throw new Error('AI_VISION_OUTPUT_INVALID');
    }

    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const costMinorUnits = estimateAiCostMinorUnits({
      modelKey: this.#visionModelKey,
      inputTokens,
      outputTokens,
    });

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: this.#visionModelKey,
      modelPolicyKey: this.#executionPolicy.policyKey,
      modelPolicyVersion: this.#executionPolicy.version,
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [
        intent.inputReference,
        ...(intent.contextReference ? [intent.contextReference] : []),
      ],
      processedAt,
      ...(connector.region !== undefined ? { region: connector.region } : {}),
      costMinorUnits,
      inputTokens,
      outputTokens,
    };

    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: 'OBSERVATION',
      outputReference: `ref://ai-vision/${intent.invocationId}`,
      outputContent: {
        mediaType: 'text/plain',
        value: generatedText,
      },
      confidence: 0.9,
      provenance,
    };
  }
}

type VisionImage =
  | { readonly mediaType: string; readonly dataBase64: string }
  | { readonly url: string };

function parseVisionInput(value: string): {
  prompt: string;
  images: VisionImage[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AI_VISION_INPUT_INVALID: expected JSON { prompt, images[] }');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AI_VISION_INPUT_INVALID: expected JSON { prompt, images[] }');
  }
  const prompt = (parsed as { prompt?: unknown }).prompt;
  const imagesRaw = (parsed as { images?: unknown }).images;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('AI_VISION_INPUT_INVALID: prompt required');
  }
  if (!Array.isArray(imagesRaw) || imagesRaw.length === 0) {
    throw new Error('AI_VISION_INPUT_INVALID: images required');
  }
  if (imagesRaw.length > 8) {
    throw new Error('AI_VISION_INPUT_INVALID: maximum 8 images');
  }
  const images: VisionImage[] = [];
  for (const entry of imagesRaw) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('AI_VISION_INPUT_INVALID: image entry invalid');
    }
    const url = (entry as { url?: unknown }).url;
    const mediaType = (entry as { mediaType?: unknown }).mediaType;
    const dataBase64 = (entry as { dataBase64?: unknown }).dataBase64;
    if (typeof url === 'string' && url.trim() !== '') {
      images.push({ url: url.trim() });
      continue;
    }
    if (
      typeof mediaType === 'string'
      && mediaType.trim() !== ''
      && typeof dataBase64 === 'string'
      && dataBase64.trim() !== ''
    ) {
      if (!mediaType.startsWith('image/')) {
        throw new Error('AI_VISION_INPUT_INVALID: mediaType must be image/*');
      }
      images.push({ mediaType: mediaType.trim(), dataBase64: dataBase64.trim() });
      continue;
    }
    throw new Error('AI_VISION_INPUT_INVALID: image needs url or mediaType+dataBase64');
  }
  return { prompt: prompt.trim(), images };
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? 90_000;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('AI_PROVIDER_TIMEOUT_INVALID');
  }
  return timeout;
}
