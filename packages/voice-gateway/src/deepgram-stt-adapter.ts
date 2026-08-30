import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import type {
  VoiceIntelligenceIntent,
  VoiceIntelligenceObservation,
  VoiceIntelligenceOperation,
  VoiceIntelligenceProvenance,
} from "./index.ts";
import type { VoiceProviderAdapter } from "./routing.ts";

export interface VoiceCredentialRequest {
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly operation: VoiceIntelligenceOperation;
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type VoiceApiTokenProvider = (request: VoiceCredentialRequest) => Promise<string>;

export interface DeepgramSttAdapterOptions {
  readonly apiToken: VoiceApiTokenProvider;
  readonly endpointBaseUrl?: string;
  readonly modelKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

export class DeepgramSttAdapter implements VoiceProviderAdapter {
  readonly adapterKey = "deepgram-stt-v1";
  readonly #apiToken: VoiceApiTokenProvider;
  readonly #endpointBaseUrl: string;
  readonly #modelKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: DeepgramSttAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://api.deepgram.com/v1/listen").replace(/\/+$/u, "");
    this.#modelKey = options.modelKey ?? "nova-2";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(input: {
    readonly intent: VoiceIntelligenceIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<VoiceIntelligenceObservation> {
    const { intent, connector } = input;
    const processedAt = this.#now();

    if (intent.operation !== "TRANSCRIBE") {
      throw new Error(`VOICE_OPERATION_UNSUPPORTED: DeepgramSttAdapter only supports TRANSCRIBE, received ${intent.operation}`);
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
      throw new Error("VOICE_CREDENTIAL_UNAVAILABLE: Leased token is empty");
    }

    const url = `${this.#endpointBaseUrl}?model=${encodeURIComponent(this.#modelKey)}&language=${encodeURIComponent(intent.languageTag)}&smart_format=true&punctuate=true`;

    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${token}`,
        "User-Agent": "expadio-voice-gateway/1.0",
      },
      body: JSON.stringify({
        url: intent.inputReference,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Network error");
      throw new Error(`VOICE_PROVIDER_ERROR: Deepgram responded with status ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
          }>;
        }>;
      };
      metadata?: {
        duration?: number;
      };
    };

    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    const durationSeconds = data.metadata?.duration ?? 60;
    const durationMilliseconds = Math.round(durationSeconds * 1000);
    // Deepgram billing estimate: e.g. $0.0043/min ≈ 1 cent per 2 minutes
    const costMinorUnits = Math.max(1, Math.ceil((durationSeconds / 60) * 0.5));

    const provenance: VoiceIntelligenceProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: this.#modelKey,
      sourceReferences: [intent.inputReference],
      processedAt,
      ...(connector.region !== undefined ? { region: connector.region } : {}),
      audioDurationMilliseconds: durationMilliseconds,
      costMinorUnits,
    };

    return {
      requestId: intent.requestId,
      tenantId: intent.tenantId,
      callId: intent.callId,
      operation: "TRANSCRIBE",
      outputReference: `ref://voice-transcript/${intent.requestId}#${encodeURIComponent(transcript.slice(0, 100))}`,
      provenance,
    };
  }
}
