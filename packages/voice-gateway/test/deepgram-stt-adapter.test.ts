import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  DeepgramSttAdapter,
  validateVoiceIntelligenceObservation,
  type VoiceIntelligenceIntent,
} from "../src/index.ts";

const connector: ConnectorDefinition = {
  connectorKey: "connector.voice.deepgram.primary",
  providerType: "deepgram",
  providerKey: "deepgram",
  ownership: "PLATFORM",
  capabilityKeys: ["voice.transcribe"],
  residencyTags: ["US"],
  complianceTags: ["HIPAA"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: false,
  region: "us-east-1",
};

const intent: VoiceIntelligenceIntent = {
  requestId: "req_voice_001",
  tenantId: "tenant_dentex_01",
  callId: "call_session_789",
  operation: "TRANSCRIBE",
  purpose: "Transcribe patient consultation call",
  inputReference: "https://storage.expadio.internal/audio/consultation-001.wav",
  languageTag: "en-US",
  governance: {
    recordingConsentEvidenceReference: "consent://recording/signed-001",
    callerDisclosureEvidenceReference: "disclosure://recorded-notice-001",
    recordingRetentionPolicy: { key: "policy.retention.recording", version: 1 },
    transcriptRetentionPolicy: { key: "policy.retention.transcript", version: 1 },
    redactionPolicy: { key: "policy.redaction.phi", version: 1 },
    jurisdictionTags: ["US-CA"],
    requiredResidencyTags: ["US"],
    requiredComplianceTags: ["HIPAA"],
    maximumCostMinorUnits: 25,
  },
  idempotencyKey: "idem_voice_111",
  requestedAt: "2026-08-30T12:00:00.000Z",
};

test("DeepgramSttAdapter transcribes audio and produces valid observation", async () => {
  let requestedUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    const h = init?.headers as any;
    requestHeaders = h;
    requestBody = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: "Doctor, I have been feeling tooth sensitivity on the upper molar.",
                  confidence: 0.98,
                },
              ],
            },
          ],
        },
        metadata: {
          duration: 45.5,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new DeepgramSttAdapter({
    apiToken: async () => "mock-deepgram-token-xyz",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:05.000Z",
  });

  const observation = await adapter.invoke({ intent, connector });

  assert.ok(requestedUrl.includes("api.deepgram.com/v1/listen"));
  assert.ok(requestedUrl.includes("model=nova-2"));
  assert.equal(requestHeaders["Authorization"], "Token mock-deepgram-token-xyz");
  assert.equal(requestBody.url, intent.inputReference);

  assert.equal(observation.requestId, intent.requestId);
  assert.equal(observation.tenantId, intent.tenantId);
  assert.equal(observation.callId, intent.callId);
  assert.equal(observation.operation, "TRANSCRIBE");
  assert.equal(observation.provenance.modelKey, "nova-2");
  assert.equal(observation.provenance.audioDurationMilliseconds, 45500);

  const validation = validateVoiceIntelligenceObservation(intent, observation);
  assert.equal(validation.valid, true);
});

test("DeepgramSttAdapter rejects unsupported operation", async () => {
  const adapter = new DeepgramSttAdapter({
    apiToken: async () => "mock-token",
  });

  const invalidIntent: VoiceIntelligenceIntent = {
    ...intent,
    operation: "SYNTHESIZE",
  };

  await assert.rejects(
    () => adapter.invoke({ intent: invalidIntent, connector }),
    /VOICE_OPERATION_UNSUPPORTED/
  );
});
