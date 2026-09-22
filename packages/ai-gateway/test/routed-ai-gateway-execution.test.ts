import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorDefinition, RoutingPolicy } from "@platform-hub/provider-registry";
import {
  RoutedAiGateway,
  GeminiAiAdapter,
  OpenAiAiAdapter,
  type AiInvocationIntent,
} from "../src/index.ts";

const geminiConnector: ConnectorDefinition = {
  connectorKey: "connector.ai.gemini.us",
  providerType: "gemini",
  providerKey: "google-ai",
  ownership: "TENANT",
  tenantId: "tenant_us_001",
  capabilityKeys: ["ai.generate", "ai.extract"],
  residencyTags: ["US"],
  complianceTags: ["HIPAA"],
  health: "HEALTHY",
  priority: 100,
  enabled: true,
  fallbackEnabled: true,
  region: "us-central1",
};

const openAiConnector: ConnectorDefinition = {
  connectorKey: "connector.ai.openai.eu",
  providerType: "openai",
  providerKey: "openai",
  ownership: "TENANT",
  tenantId: "tenant_eu_001",
  capabilityKeys: ["ai.generate", "ai.extract"],
  residencyTags: ["EU"],
  complianceTags: ["GDPR"],
  health: "HEALTHY",
  priority: 90,
  enabled: true,
  fallbackEnabled: false,
  region: "eu-west-1",
};

test("RoutedAiGateway routes US HIPAA intent through GeminiAiAdapter", async () => {
  const geminiAdapter = new GeminiAiAdapter({
    apiToken: async (req) => `leased-token-for-${req.tenantId}`,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{\"result\":\"Gemini response\"}" }] } }],
          usageMetadata: { totalTokenCount: 100, promptTokenCount: 20, candidatesTokenCount: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  const openAiAdapter = new OpenAiAiAdapter({
    apiToken: async () => "leased-openai-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"result":"OpenAI response"}' } }],
          usage: { total_tokens: 100, prompt_tokens: 40, completion_tokens: 60 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  const gateway = new RoutedAiGateway({
    connectors: [geminiConnector, openAiConnector],
    adapters: new Map([
      ["connector.ai.gemini.us", geminiAdapter],
      ["connector.ai.openai.eu", openAiAdapter],
    ]),
  });

  const intent: AiInvocationIntent = {
    invocationId: "inv_us_01",
    tenantId: "tenant_us_001",
    operation: "EXTRACT",
    purpose: "Patient advice",
    inputReference: "Symptoms query",
    promptConfiguration: { key: "prompt.advice", version: 1 },
    governance: {
      requiredResidencyTags: ["US"],
      requiredComplianceTags: ["HIPAA"],
      maximumCostMinorUnits: 10,
    },
    idempotencyKey: "idem_us_01",
    requestedAt: "2026-08-30T12:00:00.000Z",
  };

  const proposal = await gateway.invoke(intent);

  assert.equal(proposal.provenance.connectorKey, "connector.ai.gemini.us");
  assert.equal(proposal.provenance.providerKey, "google-ai");
  assert.equal(proposal.provenance.region, "us-central1");
});

test("RoutedAiGateway routes EU GDPR intent to tenant-owned OpenAI adapter", async () => {
  const geminiAdapter = new GeminiAiAdapter({
    apiToken: async () => "gemini-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{\"result\":\"Gemini response\"}" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
        }),
        { status: 200 }
      ),
  });

  const openAiAdapter = new OpenAiAiAdapter({
    apiToken: async () => "openai-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"result":"OpenAI response"}' } }],
          usage: { total_tokens: 50, prompt_tokens: 20, completion_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ),
  });

  const policy: RoutingPolicy = {
    tenantId: "tenant_eu_001",
    capabilityKey: "ai.extract",
    preferTenantOwned: true,
    requiredResidencyTags: ["EU"],
  };

  const gateway = new RoutedAiGateway({
    connectors: [geminiConnector, openAiConnector],
    adapters: new Map([
      ["connector.ai.gemini.us", geminiAdapter],
      ["connector.ai.openai.eu", openAiAdapter],
    ]),
    policies: [policy],
  });

  const intent: AiInvocationIntent = {
    invocationId: "inv_eu_01",
    tenantId: "tenant_eu_001",
    operation: "EXTRACT",
    purpose: "EU record extraction",
    inputReference: "Patient data in EU",
    promptConfiguration: { key: "prompt.extract", version: 1 },
    governance: {
      requiredResidencyTags: ["EU"],
      requiredComplianceTags: ["GDPR"],
      maximumCostMinorUnits: 20,
    },
    idempotencyKey: "idem_eu_01",
    requestedAt: "2026-08-30T12:00:00.000Z",
  };

  const proposal = await gateway.invoke(intent);

  assert.equal(proposal.provenance.connectorKey, "connector.ai.openai.eu");
  assert.equal(proposal.provenance.providerKey, "openai");
  assert.equal(proposal.provenance.region, "eu-west-1");
  assert.equal(proposal.status, "PROPOSAL");
});

test('RoutedAiGateway requires cost evidence when a ceiling is configured', async () => {
  const gateway = new RoutedAiGateway({
    connectors: [geminiConnector],
    adapters: new Map([[geminiConnector.connectorKey, {
      async invoke({ intent, connector }) {
        return {
          invocationId: intent.invocationId,
          tenantId: intent.tenantId,
          status: 'OBSERVATION' as const,
          outputReference: 'artifact://output',
          provenance: {
            connectorKey: connector.connectorKey,
            providerKey: connector.providerKey,
            modelKey: 'test-model',
            promptConfigurationKey: intent.promptConfiguration.key,
            promptConfigurationVersion: intent.promptConfiguration.version,
            sourceReferences: [intent.inputReference],
            processedAt: '2026-09-13T15:00:00.000Z',
          },
        };
      },
    }]]),
  });

  await assert.rejects(() => gateway.invoke({
    invocationId: 'cost-evidence-1', tenantId: 'tenant_us_001', operation: 'EXTRACT',
    purpose: 'Test governed cost evidence', inputReference: 'artifact://input',
    promptConfiguration: { key: 'test', version: 1 },
    governance: { requiredResidencyTags: ['US'], requiredComplianceTags: ['HIPAA'], maximumCostMinorUnits: 10 },
    idempotencyKey: 'cost-evidence-1', requestedAt: '2026-09-13T15:00:00.000Z',
  }), (error: unknown) => error instanceof Error && error.message.includes('cost evidence'));
});
