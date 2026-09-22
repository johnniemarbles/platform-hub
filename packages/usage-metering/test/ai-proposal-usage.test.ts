import assert from 'node:assert/strict';
import test from 'node:test';
import { composeAiProposalUsageEvents } from '../src/ai-proposal-usage.ts';

test('compose includes request cost and token meters', () => {
  const events = composeAiProposalUsageEvents({
    proposal: {
      invocationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      operation: 'GENERATE',
      provenance: {
        connectorKey: 'openai-byok',
        providerKey: 'openai',
        modelKey: 'gpt-4o-mini',
        processedAt: '2026-09-18T12:00:00.000Z',
        costMinorUnits: 42,
        inputTokens: 100,
        outputTokens: 50,
        sourceReferences: ['ref://input'],
      },
    },
  });

  assert.equal(events.length, 3);
  const request = events.find((e) => e.meter === 'AI_REQUEST');
  assert.ok(request);
  assert.equal(request.costMinorUnits, 42);
  assert.equal(request.capabilityKey, 'ai.generate');
  assert.equal(request.providerCostOwnership, 'BYOK');

  const input = events.find((e) => e.meter === 'AI_INPUT_TOKEN');
  assert.ok(input);
  assert.equal(input.quantity, 100);
  assert.equal(input.costMinorUnits, 0);

  const output = events.find((e) => e.meter === 'AI_OUTPUT_TOKEN');
  assert.ok(output);
  assert.equal(output.quantity, 50);
});

test('skips zero token meters', () => {
  const events = composeAiProposalUsageEvents({
    proposal: {
      invocationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      operation: 'EMBED',
      provenance: {
        connectorKey: 'openai-byok',
        providerKey: 'openai',
        modelKey: 'text-embedding-3-small',
        processedAt: '2026-09-18T12:00:00.000Z',
        costMinorUnits: 2,
        inputTokens: 0,
        outputTokens: 0,
        sourceReferences: ['ref://input'],
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].meter, 'AI_REQUEST');
});
