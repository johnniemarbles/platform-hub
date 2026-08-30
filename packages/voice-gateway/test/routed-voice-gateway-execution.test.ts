import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  RoutedVoiceGateway,
  DeepgramSttAdapter,
  ElevenLabsTtsAdapter,
  type VoiceIntelligenceIntent,
} from "../src/index.ts";

const deepgramConnector: ConnectorDefinition = {
  connectorKey: "connector.voice.deepgram.us",
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

const elevenLabsConnector: ConnectorDefinition = {
  connectorKey: "connector.voice.elevenlabs.us",
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

test("RoutedVoiceGateway routes TRANSCRIBE operation to DeepgramSttAdapter", async () => {
  const deepgramAdapter = new DeepgramSttAdapter({
    apiToken: async () => "deepgram-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "Test transcript" }] }] },
          metadata: { duration: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  const elevenLabsAdapter = new ElevenLabsTtsAdapter({
    apiToken: async () => "elevenlabs-token",
    fetchImpl: async () => new Response(Buffer.from("AUDIO"), { status: 200 }),
  });

  const gateway = new RoutedVoiceGateway({
    connectors: [deepgramConnector, elevenLabsConnector],
    adapters: new Map([
      ["connector.voice.deepgram.us", deepgramAdapter],
      ["connector.voice.elevenlabs.us", elevenLabsAdapter],
    ]),
  });

  const intent: VoiceIntelligenceIntent = {
    requestId: "req_stt_01",
    tenantId: "tenant_001",
    callId: "call_001",
    operation: "TRANSCRIBE",
    purpose: "Transcribe check-in",
    inputReference: "https://storage.expadio.internal/audio/checkin.wav",
    languageTag: "en-US",
    governance: {
      recordingConsentEvidenceReference: "consent://001",
      recordingRetentionPolicy: { key: "pol.rec", version: 1 },
      transcriptRetentionPolicy: { key: "pol.tx", version: 1 },
      redactionPolicy: { key: "pol.redact", version: 1 },
      jurisdictionTags: ["US"],
      requiredResidencyTags: ["US"],
      requiredComplianceTags: ["HIPAA"],
      maximumCostMinorUnits: 50,
    },
    idempotencyKey: "idem_stt_01",
    requestedAt: "2026-08-30T12:00:00.000Z",
  };

  const observation = await gateway.invoke(intent);

  assert.equal(observation.operation, "TRANSCRIBE");
  assert.equal(observation.provenance.connectorKey, "connector.voice.deepgram.us");
  assert.equal(observation.provenance.providerKey, "deepgram");
});

test("RoutedVoiceGateway routes SYNTHESIZE operation to ElevenLabsTtsAdapter", async () => {
  const deepgramAdapter = new DeepgramSttAdapter({
    apiToken: async () => "deepgram-token",
  });

  const elevenLabsAdapter = new ElevenLabsTtsAdapter({
    apiToken: async () => "elevenlabs-token",
    fetchImpl: async () => new Response(Buffer.from("AUDIO"), { status: 200 }),
  });

  const gateway = new RoutedVoiceGateway({
    connectors: [deepgramConnector, elevenLabsConnector],
    adapters: new Map([
      ["connector.voice.deepgram.us", deepgramAdapter],
      ["connector.voice.elevenlabs.us", elevenLabsAdapter],
    ]),
  });

  const intent: VoiceIntelligenceIntent = {
    requestId: "req_tts_01",
    tenantId: "tenant_001",
    callId: "call_001",
    operation: "SYNTHESIZE",
    purpose: "Greeting",
    inputReference: "Good morning patient.",
    languageTag: "en-US",
    governance: {
      recordingConsentEvidenceReference: "consent://001",
      recordingRetentionPolicy: { key: "pol.rec", version: 1 },
      transcriptRetentionPolicy: { key: "pol.tx", version: 1 },
      redactionPolicy: { key: "pol.redact", version: 1 },
      jurisdictionTags: ["US"],
      requiredResidencyTags: ["US"],
      requiredComplianceTags: ["SOC2"],
      maximumCostMinorUnits: 50,
    },
    idempotencyKey: "idem_tts_01",
    requestedAt: "2026-08-30T12:00:00.000Z",
  };

  const observation = await gateway.invoke(intent);

  assert.equal(observation.operation, "SYNTHESIZE");
  assert.equal(observation.provenance.connectorKey, "connector.voice.elevenlabs.us");
  assert.equal(observation.provenance.providerKey, "elevenlabs");
});
