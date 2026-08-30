import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  ElevenLabsTtsAdapter,
  validateVoiceIntelligenceObservation,
  type VoiceIntelligenceIntent,
} from "../src/index.ts";

const connector: ConnectorDefinition = {
  connectorKey: "connector.voice.elevenlabs.primary",
  providerType: "elevenlabs",
  providerKey: "elevenlabs",
  ownership: "PLATFORM",
  capabilityKeys: ["voice.synthesize"],
  residencyTags: ["US"],
  complianceTags: ["SOC2"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: false,
  region: "us-east-1",
};

const intent: VoiceIntelligenceIntent = {
  requestId: "req_tts_001",
  tenantId: "tenant_dentex_01",
  callId: "call_session_789",
  operation: "SYNTHESIZE",
  purpose: "Synthesize doctor greeting message",
  inputReference: "Hello, this is the clinical desk calling regarding your upcoming appointment.",
  languageTag: "en-US",
  governance: {
    recordingConsentEvidenceReference: "consent://recording/signed-001",
    callerDisclosureEvidenceReference: "disclosure://recorded-notice-001",
    recordingRetentionPolicy: { key: "policy.retention.recording", version: 1 },
    transcriptRetentionPolicy: { key: "policy.retention.transcript", version: 1 },
    redactionPolicy: { key: "policy.redaction.phi", version: 1 },
    jurisdictionTags: ["US-CA"],
    requiredResidencyTags: ["US"],
    requiredComplianceTags: ["SOC2"],
  },
  idempotencyKey: "idem_tts_222",
  requestedAt: "2026-08-30T12:00:00.000Z",
};

test("ElevenLabsTtsAdapter synthesizes speech audio reference and calculates cost", async () => {
  let requestedUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    const h = init?.headers as any;
    requestHeaders = h;
    requestBody = JSON.parse(String(init?.body));

    return new Response(Buffer.from("FAKE_MP3_AUDIO_BYTES"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  const adapter = new ElevenLabsTtsAdapter({
    apiToken: async () => "mock-elevenlabs-key-999",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:06.000Z",
  });

  const observation = await adapter.invoke({ intent, connector });

  assert.ok(requestedUrl.includes("api.elevenlabs.io/v1/text-to-speech"));
  assert.equal(requestHeaders["xi-api-key"], "mock-elevenlabs-key-999");
  assert.equal(requestBody.text, intent.inputReference);
  assert.equal(requestBody.model_id, "eleven_multilingual_v2");

  assert.equal(observation.requestId, intent.requestId);
  assert.equal(observation.tenantId, intent.tenantId);
  assert.equal(observation.operation, "SYNTHESIZE");
  assert.equal(observation.outputReference, `ref://voice-audio/${intent.requestId}`);
  assert.ok(observation.provenance.audioDurationMilliseconds! > 0);
  assert.ok(observation.provenance.costMinorUnits! > 0);

  const validation = validateVoiceIntelligenceObservation(intent, observation);
  assert.equal(validation.valid, true);
});
