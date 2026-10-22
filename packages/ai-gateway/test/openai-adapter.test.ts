import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  OpenAiAiAdapter,
  validateAiProposal,
  type AiInvocationIntent,
} from "../src/index.ts";

const connector: ConnectorDefinition = {
  connectorKey: "connector.ai.openai.primary",
  providerType: "openai",
  providerKey: "openai",
  ownership: "PLATFORM",
  capabilityKeys: ["ai.generate", "ai.extract", "ai.embed"],
  residencyTags: ["US"],
  complianceTags: ["SOC2"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: false,
  region: "us-east-1",
};

const intent: AiInvocationIntent = {
  invocationId: "inv_openai_123",
  tenantId: "tenant_xyz",
  operation: "EXTRACT",
  purpose: "Extract dental codes",
  inputReference: "Procedure: D0150 Comprehensive oral evaluation",
  promptConfiguration: {
    key: "prompt.dental.codes",
    version: 2,
  },
  governance: {
    requiredResidencyTags: ["US"],
    requiredComplianceTags: ["SOC2"],
  },
  idempotencyKey: "idem_openai_999",
  requestedAt: "2026-08-30T12:00:00.000Z",
};

test("OpenAiAiAdapter invokes chat completions and returns validated proposal", async () => {
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
        choices: [
          {
            message: {
              content: JSON.stringify({ code: "D0150", category: "Diagnostic" }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 10,
          total_tokens: 25,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new OpenAiAiAdapter({
    apiToken: async () => "mock-openai-key-abc",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:02.000Z",
  });

  const proposal = await adapter.invoke({ intent, connector });

  assert.equal(requestedUrl, "https://api.openai.com/v1/chat/completions");
  assert.equal(requestHeaders["Authorization"], "Bearer mock-openai-key-abc");
  assert.equal(requestBody.model, "gpt-4o-mini");
  assert.equal(requestBody.max_tokens, 2048);
  assert.equal(requestBody.temperature, 0);
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(proposal.status, "PROPOSAL");
  assert.equal(proposal.provenance.modelKey, "gpt-4o-mini");
  assert.equal(proposal.provenance.costMinorUnits, 1);
  assert.equal(proposal.provenance.modelPolicyKey, 'ai.model.openai.default');

  const validation = validateAiProposal(intent, proposal);
  assert.equal(validation.valid, true);
});

test("OpenAiAiAdapter handles embeddings via /v1/embeddings", async () => {
  let requestedUrl = "";
  let requestBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        data: [{ embedding: [0.01, 0.02, 0.03] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new OpenAiAiAdapter({
    apiToken: async () => "mock-openai-key-abc",
    fetchImpl: mockFetch,
    now: () => "2026-08-30T12:00:02.000Z",
  });

  const embedIntent: AiInvocationIntent = {
    ...intent,
    operation: "EMBED",
  };

  const proposal = await adapter.invoke({ intent: embedIntent, connector });

  assert.equal(requestedUrl, "https://api.openai.com/v1/embeddings");
  assert.equal(requestBody.model, "text-embedding-3-small");
  assert.equal(proposal.status, "OBSERVATION");
  assert.equal(proposal.outputReference, `ref://ai-embedding/${embedIntent.invocationId}`);
  assert.equal(proposal.outputContent?.mediaType, "application/json");
  const payload = JSON.parse(proposal.outputContent?.value ?? "{}");
  assert.equal(payload.dimensions, 3);
  assert.deepEqual(payload.embedding, [0.01, 0.02, 0.03]);

  const validation = validateAiProposal(embedIntent, proposal);
  assert.equal(validation.valid, true);
});

test('OpenAiAiAdapter classifies and redacts provider failures', async () => {
  const adapter = new OpenAiAiAdapter({
    apiToken: async () => 'mock-key',
    fetchImpl: async () => new Response('SENSITIVE patient data', { status: 401 }),
  });
  await assert.rejects(() => adapter.invoke({ intent, connector }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /AI_PROVIDER_AUTH_FAILED/);
    assert.doesNotMatch(error.message, /SENSITIVE|patient data/);
    return true;
  });
});
