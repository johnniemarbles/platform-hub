import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAiWorkerAdapters } from '../src/build-worker-adapters.ts';

test('worker adapters include OpenAI-compatible catalog providers', () => {
  const adapters = buildAiWorkerAdapters({
    operation: 'GENERATE',
    apiToken: { async token() { return 'x'; } } as never,
    now: () => new Date().toISOString(),
    requestTimeoutMs: 8_000,
    connectors: [
      {
        connectorKey: 'nvidia-byok',
        providerType: 'nvidia',
        providerKey: 'nvidia',
        ownership: 'TENANT',
        enabled: true,
        health: 'HEALTHY',
        capabilityKeys: ['ai.generate'],
        priority: 1,
        fallbackEnabled: false,
        residencyTags: [],
        complianceTags: [],
      },
    ],
  });
  assert.equal(adapters.has('nvidia-byok'), true);
});
