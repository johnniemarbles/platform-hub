import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  GeminiAiAdapter,
  validateAiProposal,
  type AiInvocationIntent,
} from "../src/index.ts";

const connector: ConnectorDefinition = {
  connectorKey: "connector.ai.gemini.primary",
  providerType: "gemini",
  providerKey: "google-ai",
  ownership: "PLATFORM",
  capabilityKeys: ["ai.generate", "ai.extract", "ai.embed"],
  residencyTags: ["US"],
  complianceTags: ["HIPAA"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: false,
  region: "us-central1",
};

const intent: AiInvocationIntent = {
  invocationId: "inv_12345",
  tenantId: "tenant_abc",
  operation: "GENERATE",
  purpose: "Draft patient summary",
  inputReference: "Patient exhibits symptoms of mild gingivitis.",
  contextReference: "Clinical history: Patient visited 6 months ago.",
  promptConfiguration: {
    key: "prompt.clinical.summary",
    version: 1,
  },
  governance: {
    requiredResidencyTags: ["US"],
    requiredComplianceTags: ["HIPAA"],
    maximumCostMinorUnits: 50,
  },
  idempotencyKey: "idem_999",
  requestedAt: "2026-08-30T12:00:00.000Z",
};

test("GeminiAiAdapter invokes generateContent, parses response and sets provenance", async () => {
  let requestedUrl = "";
  let requestHeaders: HeadersInit = {};
  let requestBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestHeaders = init?.headers ?? {};
    requestBody = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "Extracted clinical summary: mild gingivitis." }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 15,
          totalTokenCount: 35,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new GeminiAiAdapter({
    apiToken: async () => "mock-gemini-key-123",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:01.000Z",
  });

  const proposal = await adapter.invoke({ intent, connector });

  assert.ok(requestedUrl.includes("gemini-3.6-flash:generateContent"));
  assert.doesNotMatch(requestedUrl, /mock-gemini-key-123|[?&]key=/);
  assert.equal((requestHeaders as Record<string, string>)["X-Goog-Api-Key"], "mock-gemini-key-123");
  assert.equal(requestBody.contents[0].parts[0].text, intent.inputReference);
  assert.equal(requestBody.systemInstruction.parts[0].text, `Context: ${intent.contextReference}`);
  assert.equal(requestBody.generationConfig.maxOutputTokens, 2048);

  assert.equal(proposal.invocationId, intent.invocationId);
  assert.equal(proposal.tenantId, intent.tenantId);
  assert.equal(proposal.status, "OBSERVATION");
  assert.equal(proposal.provenance.connectorKey, connector.connectorKey);
  assert.equal(proposal.provenance.providerKey, connector.providerKey);
  assert.equal(proposal.provenance.modelKey, "gemini-3.6-flash");
  // gemini-3.6-flash has no entry in cost-tables.ts yet (its real per-token
  // pricing isn't verified), so this correctly falls back to the UNKNOWN
  // default rate rather than a fabricated price.
  assert.equal(proposal.provenance.costMinorUnits, 1);
  assert.deepEqual(proposal.provenance.sourceReferences, [intent.inputReference, intent.contextReference]);

  const validation = validateAiProposal(intent, proposal);
  assert.equal(validation.valid, true);
});

test("GeminiAiAdapter handles EMBED operation with embedContent API", async () => {
  let requestedUrl = "";

  const mockFetch: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        embedding: {
          values: [0.1, 0.2, 0.3],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new GeminiAiAdapter({
    apiToken: async () => "mock-gemini-key-123",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:01.000Z",
  });

  const embedIntent: AiInvocationIntent = {
    ...intent,
    operation: "EMBED",
  };

  const proposal = await adapter.invoke({ intent: embedIntent, connector });

  assert.ok(requestedUrl.includes("gemini-embedding-001:embedContent"));
  assert.equal(proposal.outputReference, `ref://ai-embedding/${embedIntent.invocationId}`);
  assert.equal(proposal.confidence, 1.0);

  const validation = validateAiProposal(embedIntent, proposal);
  assert.equal(validation.valid, true);
});

test("GeminiAiAdapter rejects empty leased token with clear error", async () => {
  const adapter = new GeminiAiAdapter({
    apiToken: async () => "",
  });

  await assert.rejects(
    () => adapter.invoke({ intent, connector }),
    /AI_CREDENTIAL_UNAVAILABLE/
  );
});

test("GeminiAiAdapter throws on provider error response", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response("SENSITIVE provider body must not escape", { status: 429 });
  };

  const adapter = new GeminiAiAdapter({
    apiToken: async () => "mock-key",
    fetchImpl: mockFetch,
  });

  await assert.rejects(() => adapter.invoke({ intent, connector }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /AI_PROVIDER_RATE_LIMITED/);
    assert.doesNotMatch(error.message, /SENSITIVE|Quota/);
    return true;
  });
});
