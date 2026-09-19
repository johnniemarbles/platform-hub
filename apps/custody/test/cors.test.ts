import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCorsOrigins, corsHeadersForRequest } from '../src/cors.ts';

test('allowedCorsOrigins parses comma list', () => {
  assert.deepEqual(
    allowedCorsOrigins({ CUSTODY_CORS_ORIGINS: ' https://a.example,https://b.example ' }),
    ['https://a.example', 'https://b.example'],
  );
  assert.deepEqual(allowedCorsOrigins({}), []);
});

test('corsHeadersForRequest only for allowlisted Origin', () => {
  const env = { CUSTODY_CORS_ORIGINS: 'https://platform.example.com' };
  const allowed = corsHeadersForRequest(
    new Request('https://custody.example.com/api/custody/wrapping-key', {
      headers: { Origin: 'https://platform.example.com' },
    }),
    env,
  );
  assert.equal(allowed['Access-Control-Allow-Origin'], 'https://platform.example.com');
  assert.match(allowed['Access-Control-Allow-Headers'] ?? '', /x-expadio-custody-ticket/);

  const denied = corsHeadersForRequest(
    new Request('https://custody.example.com/health', {
      headers: { Origin: 'https://evil.example' },
    }),
    env,
  );
  assert.deepEqual(denied, {});
});
