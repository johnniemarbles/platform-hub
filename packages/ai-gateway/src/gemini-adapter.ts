import { estimateAiCostMinorUnits } from './cost-tables.ts';
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import type {
  AiInvocationIntent,
  AiOperation,
  AiProposal,
  AiProvenance,
} from "./index.ts";
import type { AiProviderAdapter } from "./routing.ts";
import { fetchAiProvider } from './provider-errors.ts';
import {
  defaultAiModelExecutionPolicy,
  enforceAiInputLimit,
  enforceStructuredAiOutput,
  modelForOperation,
  requiresStructuredJson,
  validateAiModelExecutionPolicy,
  type AiModelExecutionPolicy,
} from './model-execution-policy.ts';

export interface AiCredentialRequest {
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly operation: AiOperation;
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type AiApiTokenProvider = (request: AiCredentialRequest) => Promise<string>;

export interface GeminiAiAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly modelKey?: string;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly executionPolicy?: AiModelExecutionPolicy;
}

export class GeminiAiAdapter implements AiProviderAdapter {
  readonly adapterKey = "gemini-v1";
  readonly #apiToken: AiApiTokenProvider;
  readonly #executionPolicy: AiModelExecutionPolicy;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;

  constructor(options: GeminiAiAdapterOptions) {
    this.#apiToken = options.apiToken;
    const fallback = defaultAiModelExecutionPolicy('gemini');
    this.#executionPolicy = validateAiModelExecutionPolicy(
      options.executionPolicy ?? (options.modelKey === undefined ? fallback : {
        ...fallback, generativeModelKey: options.modelKey, embeddingModelKey: options.modelKey,
      }),
      'google-ai',
    );
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs);
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    if (intent.operation === 'RERANK' || intent.operation === 'VISION_ANALYZE') {
      throw new Error(`AI_OPERATION_UNSUPPORTED: Gemini adapter does not support ${intent.operation}`);
    }
    const policy = validateAiModelExecutionPolicy(this.#executionPolicy, connector.providerKey);
    enforceAiInputLimit(policy, intent.inputReference, intent.contextReference);
    const modelKey = modelForOperation(policy, intent.operation);
    const processedAt = this.#now();

    const token = await this.#apiToken({
      tenantId: intent.tenantId,
      connectorKey: connector.connectorKey,
      operation: intent.operation,
      purpose: intent.purpose,
      idempotencyKey: intent.idempotencyKey,
      requestedAt: intent.requestedAt,
    });

    if (!token || token.trim() === "") {
      throw new Error("AI_CREDENTIAL_UNAVAILABLE: Leased token is empty");
    }

    if (intent.operation === "EMBED") {
      return this.#handleEmbed({ intent, connector, modelKey, token, processedAt });
    }

    return this.#handleGenerate({ intent, connector, modelKey, token, processedAt });
  }

  async #handleGenerate(params: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
    readonly modelKey: string;
    readonly token: string;
    readonly processedAt: string;
  }): Promise<AiProposal> {
    const { intent, connector, modelKey, token, processedAt } = params;

    const url = `${this.#endpointBaseUrl}/v1beta/models/${encodeURIComponent(modelKey)}:generateContent`;

    const promptText = intent.inputReference;
    const requestBody: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }],
        },
      ],
      generationConfig: {
        temperature: intent.operation === "EXTRACT" || intent.operation === "CLASSIFY" ? 0 : this.#executionPolicy.temperature,
        maxOutputTokens: this.#executionPolicy.maximumOutputTokens,
        ...(requiresStructuredJson(intent.operation) ? { responseMimeType: 'application/json' } : {}),
      },
    };

    if (intent.contextReference) {
      requestBody.systemInstruction = {
        parts: [{ text: `Context: ${intent.contextReference}` }],
      };
    }

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Client": "expadio-ai-gateway/1.0",
        "X-Goog-Api-Key": token,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const firstCandidate = data.candidates?.[0];
    const generatedText = firstCandidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    enforceStructuredAiOutput(intent.operation, generatedText);
    const inputTokens = data.usageMetadata?.promptTokenCount;
    const outputTokens = data.usageMetadata?.candidatesTokenCount;
    const completeTokenEvidence = inputTokens !== undefined && outputTokens !== undefined;
    const costMinorUnits = completeTokenEvidence
      ? estimateAiCostMinorUnits({ modelKey, inputTokens, outputTokens })
      : undefined;

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey,
      modelPolicyKey: this.#executionPolicy.policyKey,
      modelPolicyVersion: this.#executionPolicy.version,
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [intent.inputReference, ...(intent.contextReference ? [intent.contextReference] : [])],
      processedAt,
      ...(connector.region !== undefined ? { region: connector.region } : {}),
      ...(costMinorUnits === undefined ? {} : { costMinorUnits }),
      costStatus: completeTokenEvidence ? 'CALCULATED' : 'UNKNOWN_TOKENS',
      priceSource: 'cost-tables',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    };

    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: intent.operation === "EXTRACT" || intent.operation === "CLASSIFY" ? "PROPOSAL" : "OBSERVATION",
      outputReference: `provider-output://${intent.invocationId}`,
      outputContent: {
        mediaType: "text/plain",
        value: generatedText,
      },
      confidence: 0.95,
      provenance,
    };
  }

  async #handleEmbed(params: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
    readonly modelKey: string;
    readonly token: string;
    readonly processedAt: string;
  }): Promise<AiProposal> {
    const { intent, connector, modelKey, token, processedAt } = params;

    const url = `${this.#endpointBaseUrl}/v1beta/models/${encodeURIComponent(modelKey)}:embedContent`;

    const requestBody = {
      content: {
        parts: [{ text: intent.inputReference }],
      },
    };

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": token,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });

    const data = (await response.json()) as {
      embedding?: { values?: number[] };
    };
    const embedding = data.embedding?.values;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("AI_EMBEDDING_OUTPUT_INVALID");
    }

    const inputTokens = Math.max(1, Math.ceil(intent.inputReference.length / 4));
    const costMinorUnits = estimateAiCostMinorUnits({
      modelKey,
      inputTokens,
      outputTokens: 0,
    });

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey,
      modelPolicyKey: this.#executionPolicy.policyKey,
      modelPolicyVersion: this.#executionPolicy.version,
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [intent.inputReference],
      processedAt,
      ...(connector.region !== undefined ? { region: connector.region } : {}),
      costMinorUnits,
      costStatus: 'CALCULATED',
      priceSource: 'cost-tables',
      inputTokens,
      outputTokens: 0,
    };

    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: "OBSERVATION",
      outputReference: `ref://ai-embedding/${intent.invocationId}`,
      outputContent: {
        mediaType: "application/json",
        value: JSON.stringify({ dimensions: embedding.length, embedding }),
      },
      confidence: 1.0,
      provenance,
    };
  }
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? 90_000;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('AI_PROVIDER_TIMEOUT_INVALID');
  }
  return timeout;
}
