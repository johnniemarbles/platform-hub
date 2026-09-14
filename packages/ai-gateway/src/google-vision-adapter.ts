import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { AiInvocationIntent, AiProposal, AiProvenance } from './index.ts';
import type { AiProviderAdapter } from './routing.ts';
import type { AiApiTokenProvider } from './gemini-adapter.ts';
import { fetchAiProvider } from './provider-errors.ts';

export interface GoogleVisionAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
}

/**
 * Google Cloud Vision TEXT / DOCUMENT_TEXT_DETECTION.
 * Uses the same leased API token pattern as other AI adapters.
 * Input is the VISION_ANALYZE JSON contract: { prompt, images[] }.
 */
export class GoogleVisionAdapter implements AiProviderAdapter {
  readonly adapterKey = 'google-vision-v1';
  readonly #apiToken: AiApiTokenProvider;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;

  constructor(options: GoogleVisionAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? 'https://vision.googleapis.com/v1').replace(/\/+$/u, '');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    if (intent.operation !== 'VISION_ANALYZE') {
      throw new Error(`AI_OPERATION_UNSUPPORTED: GoogleVisionAdapter only supports VISION_ANALYZE, got ${intent.operation}`);
    }
    const parsed = parseVisionInput(intent.inputReference);
    const token = await this.#apiToken({
      tenantId: intent.tenantId,
      connectorKey: connector.connectorKey,
      operation: intent.operation,
      purpose: intent.purpose,
      idempotencyKey: intent.idempotencyKey,
      requestedAt: intent.requestedAt,
    });
    if (!token || token.trim() === '') throw new Error('AI_CREDENTIAL_UNAVAILABLE: Leased token is empty');

    const requests = parsed.images.map((image) => ({
      image: 'dataBase64' in image
        ? { content: image.dataBase64 }
        : { source: { imageUri: image.url } },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'TEXT_DETECTION' }],
    }));

    const response = await fetchAiProvider(
      connector.providerKey,
      this.#fetch,
      `${this.#endpointBaseUrl}/images:annotate?key=${encodeURIComponent(token.trim())}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.trim()}`,
          'User-Agent': 'expadio-ai-gateway/1.0',
        },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      },
    );
    const data = (await response.json()) as {
      responses?: Array<{
        fullTextAnnotation?: { text?: string };
        textAnnotations?: Array<{ description?: string }>;
        error?: { message?: string };
      }>;
    };
    const texts = (data.responses ?? []).map((row) => {
      if (row.error?.message) throw new Error(`AI_VISION_PROVIDER_ERROR: ${row.error.message}`);
      return row.fullTextAnnotation?.text
        ?? row.textAnnotations?.[0]?.description
        ?? '';
    });
    const generatedText = texts.join('\n').trim();
    if (generatedText === '') throw new Error('AI_VISION_OUTPUT_INVALID');

    const processedAt = this.#now();
    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: 'google-vision.document-text-detection',
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [intent.inputReference],
      processedAt,
    };
    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: 'OBSERVATION',
      outputReference: `ref://ai-vision/${intent.invocationId}`,
      outputContent: { mediaType: 'text/plain', value: generatedText },
      confidence: 0.92,
      provenance,
    };
  }
}

function parseVisionInput(value: string): {
  prompt: string;
  images: Array<{ mediaType: string; dataBase64: string } | { url: string }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AI_VISION_INPUT_INVALID: expected JSON { prompt, images[] }');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AI_VISION_INPUT_INVALID');
  }
  const prompt = (parsed as { prompt?: unknown }).prompt;
  const imagesRaw = (parsed as { images?: unknown }).images;
  if (typeof prompt !== 'string' || !Array.isArray(imagesRaw) || imagesRaw.length === 0) {
    throw new Error('AI_VISION_INPUT_INVALID');
  }
  return {
    prompt: prompt.trim(),
    images: imagesRaw.map((entry) => {
      if (typeof entry !== 'object' || entry === null) throw new Error('AI_VISION_INPUT_INVALID');
      const url = (entry as { url?: unknown }).url;
      const mediaType = (entry as { mediaType?: unknown }).mediaType;
      const dataBase64 = (entry as { dataBase64?: unknown }).dataBase64;
      if (typeof url === 'string' && url.trim() !== '') return { url: url.trim() };
      if (typeof mediaType === 'string' && typeof dataBase64 === 'string') {
        return { mediaType: mediaType.trim(), dataBase64: dataBase64.trim() };
      }
      throw new Error('AI_VISION_INPUT_INVALID');
    }),
  };
}
