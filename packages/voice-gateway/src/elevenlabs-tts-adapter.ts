import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import type {
  VoiceIntelligenceIntent,
  VoiceIntelligenceObservation,
  VoiceIntelligenceProvenance,
} from "./index.ts";
import type { VoiceProviderAdapter } from "./routing.ts";
import type { VoiceApiTokenProvider } from "./deepgram-stt-adapter.ts";

export interface ElevenLabsTtsAdapterOptions {
  readonly apiToken: VoiceApiTokenProvider;
  readonly endpointBaseUrl?: string;
  readonly defaultVoiceId?: string;
  readonly modelKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

export class ElevenLabsTtsAdapter implements VoiceProviderAdapter {
  readonly adapterKey = "elevenlabs-tts-v1";
  readonly #apiToken: VoiceApiTokenProvider;
  readonly #endpointBaseUrl: string;
  readonly #defaultVoiceId: string;
  readonly #modelKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: ElevenLabsTtsAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#endpointBaseUrl = (options.endpointBaseUrl ?? "https://api.elevenlabs.io/v1/text-to-speech").replace(/\/+$/u, "");
    this.#defaultVoiceId = options.defaultVoiceId ?? "21m00Tcm4TlvDq8ikWAM";
    this.#modelKey = options.modelKey ?? "eleven_multilingual_v2";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(input: {
    readonly intent: VoiceIntelligenceIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<VoiceIntelligenceObservation> {
    const { intent, connector } = input;
    const processedAt = this.#now();

    if (intent.operation !== "SYNTHESIZE") {
      throw new Error(`VOICE_OPERATION_UNSUPPORTED: ElevenLabsTtsAdapter only supports SYNTHESIZE, received ${intent.operation}`);
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

    const voiceId = this.#defaultVoiceId;
    const url = `${this.#endpointBaseUrl}/${encodeURIComponent(voiceId)}`;

    const textToSynthesize = intent.inputReference;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": token,
        "User-Agent": "expadio-voice-gateway/1.0",
      },
      body: JSON.stringify({
        text: textToSynthesize,
        model_id: this.#modelKey,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Network error");
      throw new Error(`VOICE_PROVIDER_ERROR: ElevenLabs responded with status ${response.status}: ${errorText}`);
    }

    // Estimate character-based cost: e.g. ~30c per 1000 characters
    const charCount = textToSynthesize.length;
    const costMinorUnits = Math.max(1, Math.ceil((charCount / 1000) * 30));
    // Estimate ~150 words per min ≈ 750 chars per min
    const estimatedDurationMs = Math.round((charCount / 12.5) * 1000);

    const provenance: VoiceIntelligenceProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: this.#modelKey,
      sourceReferences: [intent.inputReference],
      processedAt,
      ...(connector.region !== undefined ? { region: connector.region } : {}),
      audioDurationMilliseconds: estimatedDurationMs,
      costMinorUnits,
    };

    return {
      requestId: intent.requestId,
      tenantId: intent.tenantId,
      callId: intent.callId,
      operation: "SYNTHESIZE",
      outputReference: `ref://voice-audio/${intent.requestId}`,
      provenance,
    };
  }
}
