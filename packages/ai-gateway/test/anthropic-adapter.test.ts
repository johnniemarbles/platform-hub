import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition } from "@platform-hub/provider-registry";
import {
  AnthropicAiAdapter,
  validateAiProposal,
  type AiInvocationIntent,
} from "../src/index.ts";

const connector: ConnectorDefinition = {
  connectorKey: "connector.ai.anthropic.primary",
  providerType: "anthropic",
  providerKey: "anthropic",
  ownership: "PLATFORM",
  capabilityKeys: ["ai.generate", "ai.extract"],
  residencyTags: ["US"],
  complianceTags: ["SOC2"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: false,
  region: "us-east-1",
};

const intent: AiInvocationIntent = {
  invocationId: "inv_anthropic_1",
  tenantId: "tenant_xyz",
  operation: "GENERATE",
  purpose: "Draft outreach",
  inputReference: "Write a short professional greeting.",
  promptConfiguration: { key: "prompt.outreach", version: 1 },
  governance: {
    requiredResidencyTags: ["US"],
    requiredComplianceTags: ["SOC2"],
  },
  idempotencyKey: "idem_anthropic_1",
  requestedAt: "2026-09-13T12:00:00.000Z",
};

test("AnthropicAiAdapter invokes Messages API and returns validated proposal", async () => {
  let requestedUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestHeaders = init?.headers as any;
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Hello from Claude." }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const adapter = new AnthropicAiAdapter({
    apiToken: async () => "mock-anthropic-key",
    fetchImpl: mockFetch,
    now: () => "2026-09-13T12:00:02.000Z",
  });

  const proposal = await adapter.invoke({ intent, connector });
  assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(requestHeaders["x-api-key"], "mock-anthropic-key");
  assert.equal(requestHeaders["anthropic-version"], "2023-06-01");
  assert.equal(requestBody.model, "claude-sonnet-4-20250514");
  assert.equal(proposal.status, "OBSERVATION");
  assert.equal(proposal.outputContent?.value, "Hello from Claude.");
  assert.equal(proposal.provenance.modelPolicyKey, "ai.model.anthropic.default");
  const validation = validateAiProposal(intent, proposal);
  assert.equal(validation.valid, true);
});

test("AnthropicAiAdapter rejects EMBED", async () => {
  const adapter = new AnthropicAiAdapter({
    apiToken: async () => "mock-key",
  });
  await assert.rejects(
    () => adapter.invoke({ intent: { ...intent, operation: "EMBED" }, connector }),
    /AI_OPERATION_UNSUPPORTED/,
  );
});
