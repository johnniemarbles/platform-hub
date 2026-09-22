import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../../../', import.meta.url);
const APPROVED_PROVIDER_CONSTRUCTION = new Set([
  'packages/ai-gateway/src/build-worker-adapters.ts',
]);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

test('application tenant AI factories delegate provider adapter construction to ai-gateway', () => {
  for (const path of [
    'apps/platform-web/lib/tenant-ai-gateway.ts',
    'apps/brand-web/lib/tenant-ai-gateway.ts',
  ]) {
    const source = read(path);
    assert.match(source, /buildAiWorkerAdapters/);
    assert.doesNotMatch(source, /new\s+(?:OpenAiAiAdapter|GeminiAiAdapter|AnthropicAiAdapter|OpenAiVisionAdapter|GoogleVisionAdapter|AwsTextractAdapter)\b/);
    assert.doesNotMatch(source, /openaiCompatibleProvider/);
  }
});

test('provider construction allow-list remains inside the AI gateway package', () => {
  for (const path of APPROVED_PROVIDER_CONSTRUCTION) {
    assert.ok(path.startsWith('packages/ai-gateway/'));
  }
});
