import assert from 'node:assert/strict';
import test from 'node:test';
import { githubProbe, probeFor } from '../src/probe.ts';

test('GitHub token probe confirms push access and advertises pr_draft capability', async () => {
  let request: { url: string; method?: string; authorization?: string } | null = null;
  const result = await githubProbe.probe({
    providerKey: 'github',
    secret: 'ghp_test_token',
    parameters: { owner: 'johnniemarbles', repo: 'expadio' },
    now: () => '2026-09-17T00:00:00.000Z',
    fetchImpl: (async (input, init) => {
      request = {
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get('Authorization') ?? undefined,
      };
      return new Response(JSON.stringify({ permissions: { push: true, pull: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.ok(request !== null);
  const observed = request as { url: string; method?: string; authorization?: string };
  assert.equal(observed.url, 'https://api.github.com/repos/johnniemarbles/expadio');
  assert.equal(observed.method, 'GET');
  assert.equal(observed.authorization, 'Bearer ghp_test_token');
  assert.equal(result.valid, true);
  assert.deepEqual(result.detectedCapabilities, ['ops.github.pr_draft']);
  assert.equal(result.warnings.length, 0);
  assert.equal(probeFor('github'), githubProbe);
});

test('GitHub token probe warns instead of advertising pr_draft capability without push access', async () => {
  const result = await githubProbe.probe({
    providerKey: 'github',
    secret: 'ghp_read_only',
    parameters: { owner: 'johnniemarbles', repo: 'expadio' },
    fetchImpl: (async () => new Response(JSON.stringify({ permissions: { push: false, pull: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.detectedCapabilities, []);
  assert.equal(result.warnings[0]?.code, 'GITHUB_PUSH_NOT_CONFIRMED');
});

test('GitHub token probe rejects when the repository cannot be read', async () => {
  const result = await githubProbe.probe({
    providerKey: 'github',
    secret: 'bad-token',
    parameters: { owner: 'johnniemarbles', repo: 'expadio' },
    fetchImpl: (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Bad credentials');
});

test('GitHub token probe requires owner and repo parameters', async () => {
  const result = await githubProbe.probe({
    providerKey: 'github',
    secret: 'ghp_test_token',
    parameters: {},
    fetchImpl: (async () => { throw new Error('should not be called'); }) as typeof fetch,
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Repository owner and name are required.');
});
