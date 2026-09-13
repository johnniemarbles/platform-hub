import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import type {
  AiInvocationIntent,
  AiProposal,
  AiProvenance,
} from "./index.ts";
import type { AiProviderAdapter } from "./routing.ts";
import type { AiApiTokenProvider } from "./gemini-adapter.ts";
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

export interface OpenAiAiAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly modelKey?: string;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly executionPolicy?: AiModelExecutionPolicy;
}

export class OpenAiAiAdapter implements AiProviderAdapter {
  readonly adapterKey = "openai-v1";
  readonly #apiToken: AiApiTokenProvider;
  readonly #executionPolicy: AiModelExecutionPolicy;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;

  constructor(options: OpenAiAiAdapterOptions) {
    this.#apiToken = options.apiToken;
    const fallback = defaultAiModelExecutionPolicy('openai');
    this.#executionPolicy = validateAiModelExecutionPolicy(
      options.executionPolicy ?? (options.modelKey === undefined ? fallback : {
        ...fallback, generativeModelKey: options.modelKey, embeddingModelKey: options.modelKey,
      }),
      'openai',
    );
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs);
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
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

    return this.#handleChat({ intent, connector, modelKey, token, processedAt });
  }

  async #handleChat(params: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
    readonly modelKey: string;
    readonly token: string;
    readonly processedAt: string;
  }): Promise<AiProposal> {
    const { intent, connector, modelKey, token, processedAt } = params;
    const url = `${this.#endpointBaseUrl}/chat/completions`;

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (intent.contextReference) {
      messages.push({
        role: "system",
        content: `Context: ${intent.contextReference}`,
      });
    }
    messages.push({
      role: "user",
      content: intent.inputReference,
    });

    const requestBody = {
      model: modelKey,
      messages,
      temperature: intent.operation === "EXTRACT" || intent.operation === "CLASSIFY" ? 0 : this.#executionPolicy.temperature,
      max_tokens: this.#executionPolicy.maximumOutputTokens,
      ...(requiresStructuredJson(intent.operation) ? { response_format: { type: 'json_object' } } : {}),
    };

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "expadio-ai-gateway/1.0",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const choice = data.choices?.[0];
    const generatedText = choice?.message?.content ?? "";
    enforceStructuredAiOutput(intent.operation, generatedText);
    const totalTokens = data.usage?.total_tokens ?? 0;
    const costMinorUnits = Math.ceil((totalTokens / 1_000) * 1);

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
      costMinorUnits,
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
    const url = `${this.#endpointBaseUrl}/embeddings`;

    const requestBody = {
      model: modelKey,
      input: intent.inputReference,
    };

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
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
      costMinorUnits: 1,
    };

    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: "OBSERVATION",
      outputReference: `ref://ai-embedding/${intent.invocationId}`,
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
