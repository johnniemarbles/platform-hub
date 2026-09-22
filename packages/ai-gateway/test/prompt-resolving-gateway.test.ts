import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiGateway, AiInvocationIntent, AiProposal } from '../src/index.ts';
import { PromptResolvingAiGateway } from '../src/prompt-resolving-gateway.ts';
import type { AiPromptResolver } from '../src/prompt-resolver.ts';

const baseIntent: AiInvocationIntent = {
  invocationId: 'inv_1',
  tenantId: 'tenant_1',
  operation: 'GENERATE',
  purpose: 'test',
  inputReference: 'User question',
  contextReference: 'Existing context',
  promptConfiguration: { key: 'prompt.test', version: 1 },
  governance: {
    requiredResidencyTags: ['US'],
    requiredComplianceTags: [],
  },
  idempotencyKey: 'idem_1',
  requestedAt: '2026-09-13T12:00:00.000Z',
};

test('PromptResolvingAiGateway applies overlays before inner invoke', async () => {
  let captured: AiInvocationIntent | null = null;
  const inner: AiGateway = {
    async invoke(intent) {
      captured = intent;
      const proposal: AiProposal = {
        invocationId: intent.invocationId,
        tenantId: intent.tenantId,
        status: 'OBSERVATION',
        outputReference: 'ref://out',
        provenance: {
          connectorKey: 'c',
          providerKey: 'p',
          modelKey: 'm',
          promptConfigurationKey: intent.promptConfiguration.key,
          promptConfigurationVersion: intent.promptConfiguration.version,
          sourceReferences: [intent.inputReference],
          processedAt: intent.requestedAt,
        },
      };
      return proposal;
    },
  };

  const resolver: AiPromptResolver = {
    async resolve() {
      return {
        key: 'prompt.test',
        version: 1,
        systemOverlay: 'SYSTEM RULES',
        userOverlay: 'USER PREFIX',
      };
    },
  };

  const gateway = new PromptResolvingAiGateway({ gateway: inner, promptResolver: resolver });
  await gateway.invoke(baseIntent);

  assert.ok(captured);
  assert.match(captured!.inputReference, /USER PREFIX/);
  assert.match(captured!.inputReference, /User question/);
  assert.match(captured!.contextReference ?? '', /SYSTEM RULES/);
  assert.match(captured!.contextReference ?? '', /Existing context/);
});

test('PromptResolvingAiGateway identity when no overlays', async () => {
  let captured: AiInvocationIntent | null = null;
  const inner: AiGateway = {
    async invoke(intent) {
      captured = intent;
      return {
        invocationId: intent.invocationId,
        tenantId: intent.tenantId,
        status: 'OBSERVATION',
        outputReference: 'ref://out',
        provenance: {
          connectorKey: 'c',
          providerKey: 'p',
          modelKey: 'm',
          promptConfigurationKey: intent.promptConfiguration.key,
          promptConfigurationVersion: intent.promptConfiguration.version,
          sourceReferences: [intent.inputReference],
          processedAt: intent.requestedAt,
        },
      };
    },
  };

  const gateway = new PromptResolvingAiGateway({ gateway: inner });
  await gateway.invoke(baseIntent);
  assert.equal(captured!.inputReference, baseIntent.inputReference);
  assert.equal(captured!.contextReference, baseIntent.contextReference);
});
