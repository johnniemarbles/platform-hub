import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedTextError, embedTextWithModel, embedTexts, type AiGateway } from '../src/index.ts';

function gateway(respond: (text: string) => string | Error): AiGateway & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async invoke(intent) {
      calls.push(intent.inputReference);
      const value = respond(intent.inputReference);
      if (value instanceof Error) throw value;
      return { outputContent: { value }, provenance: { modelKey: 'text-embedding-3-small' } } as never;
    },
  } as AiGateway & { calls: string[] };
}

test('embedTextWithModel returns the vector and the model that made it', async () => {
  const result = await embedTextWithModel(gateway(() => JSON.stringify({ dimensions: 2, embedding: [0.1, 0.2] })), { tenantId: 't', text: 'hi', purpose: 'p' });
  assert.deepEqual(result, { vector: [0.1, 0.2], modelKey: 'text-embedding-3-small' });
  await assert.rejects(embedTextWithModel(gateway(() => '{"embedding":[]}'), { tenantId: 't', text: 'hi', purpose: 'p' }), EmbedTextError);
  await assert.rejects(embedTextWithModel(gateway(() => 'not json'), { tenantId: 't', text: 'hi', purpose: 'p' }), EmbedTextError);
});

test('embedTexts keeps order, bounds concurrency and turns failures into null', async () => {
  let inFlight = 0;
  let peak = 0;
  const g: AiGateway = {
    async invoke(intent) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (intent.inputReference === 'bad') throw new Error('AI_PROVIDER_RATE_LIMITED');
      return { outputContent: { value: JSON.stringify({ embedding: [intent.inputReference.length] }) }, provenance: { modelKey: 'm' } } as never;
    },
  } as AiGateway;
  const results = await embedTexts(g, { tenantId: 't', texts: ['a', 'bb', 'bad', 'dddd', 'eeeee'], purpose: 'p', concurrency: 2 });
  assert.deepEqual(results.map((result) => result?.vector[0] ?? null), [1, 2, null, 4, 5]);
  assert.ok(peak <= 2);
});
