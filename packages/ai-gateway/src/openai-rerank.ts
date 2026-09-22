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

export interface OpenAiRerankAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly executionPolicy?: AiModelExecutionPolicy;
  /** Model for scoring documents; defaults to generative policy model. */
  readonly rerankModelKey?: string;
}

/**
 * OpenAI-backed RERANK via chat completions.
 *
 * Intent contract:
 * - inputReference: JSON `{ "query": string, "documents": string[] }`
 * - outputContent: JSON `{ "ranked": [{ "index": number, "score": number, "document": string }] }`
 *
 * Observation only — callers persist rankings into knowledge/RAG flows.
 */
export class OpenAiRerankAdapter implements AiProviderAdapter {
  readonly adapterKey = 'openai-rerank-v1';
  readonly #apiToken: AiApiTokenProvider;
  readonly #executionPolicy: AiModelExecutionPolicy;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;
  readonly #rerankModelKey: string;

  constructor(options: OpenAiRerankAdapterOptions) {
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
    this.#rerankModelKey = options.rerankModelKey ?? this.#executionPolicy.generativeModelKey;
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    if (intent.operation !== 'RERANK') {
      throw new Error(`AI_OPERATION_UNSUPPORTED: OpenAiRerankAdapter only supports RERANK, got ${intent.operation}`);
    }

    enforceAiInputLimit(this.#executionPolicy, intent.inputReference, intent.contextReference);
    const processedAt = this.#now();
    const parsed = parseRerankInput(intent.inputReference);

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

    const docBlock = parsed.documents
      .map((doc, index) => `[${index}] ${doc}`)
      .join('\n');
    const system = intent.contextReference
      ? `Context: ${intent.contextReference}\n\nYou rank documents for relevance. Respond with JSON only.`
      : 'You rank documents for relevance. Respond with JSON only.';
    const user = `Query: ${parsed.query}\n\nDocuments:\n${docBlock}\n\nReturn JSON: {"ranked":[{"index":0,"score":0.0}]} with all document indices sorted by score descending (0..1).`;

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, `${this.#endpointBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'expadio-ai-gateway/1.0',
      },
      body: JSON.stringify({
        model: this.#rerankModelKey,
        temperature: 0,
        max_tokens: this.#executionPolicy.maximumOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    const ranked = normalizeRanked(raw, parsed.documents);

    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const costMinorUnits = estimateAiCostMinorUnits({
      modelKey: this.#rerankModelKey,
      inputTokens,
      outputTokens,
    });

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: this.#rerankModelKey,
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
      outputReference: `ref://ai-rerank/${intent.invocationId}`,
      outputContent: {
        mediaType: 'application/json',
        value: JSON.stringify({ ranked }),
      },
      confidence: ranked[0]?.score ?? 0.5,
      provenance,
    };
  }
}

function parseRerankInput(value: string): { query: string; documents: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AI_RERANK_INPUT_INVALID: expected JSON { query, documents[] }');
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || typeof (parsed as { query?: unknown }).query !== 'string'
    || !Array.isArray((parsed as { documents?: unknown }).documents)
  ) {
    throw new Error('AI_RERANK_INPUT_INVALID: expected JSON { query, documents[] }');
  }
  const query = (parsed as { query: string }).query.trim();
  const documents = (parsed as { documents: unknown[] }).documents
    .map((d) => (typeof d === 'string' ? d : String(d)))
    .filter((d) => d.trim() !== '');
  if (query === '' || documents.length === 0) {
    throw new Error('AI_RERANK_INPUT_INVALID: query and documents required');
  }
  if (documents.length > 50) {
    throw new Error('AI_RERANK_INPUT_INVALID: maximum 50 documents');
  }
  return { query, documents };
}

function normalizeRanked(
  raw: string,
  documents: readonly string[],
): Array<{ index: number; score: number; document: string }> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('AI_RERANK_OUTPUT_INVALID');
  }
  const rankedRaw = (body as { ranked?: unknown }).ranked;
  if (!Array.isArray(rankedRaw) || rankedRaw.length === 0) {
    throw new Error('AI_RERANK_OUTPUT_INVALID');
  }
  const seen = new Set<number>();
  const ranked: Array<{ index: number; score: number; document: string }> = [];
  for (const entry of rankedRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const index = Number((entry as { index?: unknown }).index);
    const score = Number((entry as { score?: unknown }).score);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) continue;
    if (!Number.isFinite(score)) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    ranked.push({
      index,
      score: Math.min(1, Math.max(0, score)),
      document: documents[index]!,
    });
  }
  if (ranked.length === 0) throw new Error('AI_RERANK_OUTPUT_INVALID');
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? 90_000;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('AI_PROVIDER_TIMEOUT_INVALID');
  }
  return timeout;
}
