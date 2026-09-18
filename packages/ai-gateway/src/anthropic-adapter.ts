import { estimateAiCostMinorUnits } from './cost-tables.ts';
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

export interface AnthropicAiAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly modelKey?: string;
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
  readonly executionPolicy?: AiModelExecutionPolicy;
  readonly anthropicVersion?: string;
}

/**
 * Anthropic Messages API adapter. Provider-neutral gateway surface only —
 * business modules must not import this SDK path directly.
 */
export class AnthropicAiAdapter implements AiProviderAdapter {
  readonly adapterKey = "anthropic-v1";
  readonly #apiToken: AiApiTokenProvider;
  readonly #executionPolicy: AiModelExecutionPolicy;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;
  readonly #anthropicVersion: string;

  constructor(options: AnthropicAiAdapterOptions) {
    this.#apiToken = options.apiToken;
    const fallback = defaultAiModelExecutionPolicy('anthropic');
    this.#executionPolicy = validateAiModelExecutionPolicy(
      options.executionPolicy ?? (options.modelKey === undefined ? fallback : {
        ...fallback,
        generativeModelKey: options.modelKey,
        embeddingModelKey: options.modelKey,
      }),
      'anthropic',
    );
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://api.anthropic.com").replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs);
    this.#anthropicVersion = options.anthropicVersion ?? "2023-06-01";
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

    if (intent.operation === "EMBED") {
      throw new Error("AI_OPERATION_UNSUPPORTED: Anthropic adapter does not support EMBED");
    }

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

    const url = `${this.#endpointBaseUrl}/v1/messages`;
    const system = intent.contextReference
      ? `Context: ${intent.contextReference}`
      : undefined;
    const userContent = requiresStructuredJson(intent.operation)
      ? `${intent.inputReference}\n\nRespond with valid JSON only.`
      : intent.inputReference;

    // temperature is deprecated for current Claude models (the API rejects
    // it outright with a 400), so it is never sent -- deterministic output
    // for CLASSIFY/EXTRACT is enforced downstream via enforceStructuredAiOutput.
    const requestBody: Record<string, unknown> = {
      model: modelKey,
      max_tokens: this.#executionPolicy.maximumOutputTokens,
      messages: [{ role: "user", content: userContent }],
    };
    if (system !== undefined) {
      requestBody.system = system;
    }

    const response = await fetchAiProvider(connector.providerKey, this.#fetch, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": token,
        "anthropic-version": this.#anthropicVersion,
        "User-Agent": "expadio-ai-gateway/1.0",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };

    const generatedText = (data.content ?? [])
      .filter((part) => part.type === "text" || part.text !== undefined)
      .map((part) => part.text ?? "")
      .join("");
    enforceStructuredAiOutput(intent.operation, generatedText);
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const costMinorUnits = estimateAiCostMinorUnits({
      modelKey,
      inputTokens,
      outputTokens,
    });

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey,
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
      status: intent.operation === "EXTRACT" || intent.operation === "CLASSIFY"
        ? "PROPOSAL"
        : "OBSERVATION",
      outputReference: `provider-output://${intent.invocationId}`,
      outputContent: {
        mediaType: "text/plain",
        value: generatedText,
      },
      confidence: 0.95,
      provenance,
    };
  }
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? 90_000;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("AI_PROVIDER_TIMEOUT_INVALID");
  }
  return timeout;
}
