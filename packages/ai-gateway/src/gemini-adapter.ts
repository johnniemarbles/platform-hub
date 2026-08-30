import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import type {
  AiInvocationIntent,
  AiOperation,
  AiProposal,
  AiProvenance,
} from "./index.ts";
import type { AiProviderAdapter } from "./routing.ts";

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
}

export class GeminiAiAdapter implements AiProviderAdapter {
  readonly adapterKey = "gemini-v1";
  readonly #apiToken: AiApiTokenProvider;
  readonly #defaultModelKey: string;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: GeminiAiAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#defaultModelKey = options.modelKey ?? "gemini-2.0-flash";
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/u, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    const modelKey = this.#defaultModelKey;
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

    const url = `${this.#endpointBaseUrl}/v1beta/models/${encodeURIComponent(modelKey)}:generateContent?key=${encodeURIComponent(token)}`;

    const promptText = intent.inputReference;
    const requestBody: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }],
        },
      ],
      generationConfig: {
        temperature: intent.operation === "EXTRACT" || intent.operation === "CLASSIFY" ? 0.1 : 0.7,
      },
    };

    if (intent.contextReference) {
      requestBody.systemInstruction = {
        parts: [{ text: `Context: ${intent.contextReference}` }],
      };
    }

    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Client": "expadio-ai-gateway/1.0",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Network error");
      throw new Error(`AI_PROVIDER_ERROR: Gemini responded with status ${response.status}: ${errorText}`);
    }

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
    const totalTokens = data.usageMetadata?.totalTokenCount ?? 0;
    const costMinorUnits = Math.ceil((totalTokens / 1_000) * 1);

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey,
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
      outputReference: `ref://ai-output/${intent.invocationId}#${encodeURIComponent(generatedText.slice(0, 120))}`,
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

    const url = `${this.#endpointBaseUrl}/v1beta/models/${encodeURIComponent(modelKey)}:embedContent?key=${encodeURIComponent(token)}`;

    const requestBody = {
      content: {
        parts: [{ text: intent.inputReference }],
      },
    };

    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Network error");
      throw new Error(`AI_PROVIDER_ERROR: Gemini responded with status ${response.status}: ${errorText}`);
    }

    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey,
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
