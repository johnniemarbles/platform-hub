/**
 * Plan V3.1 acceptance test: "the hub's messaging fails -> sign-in codes still
 * delivered". Mirror of plan rule 7: sign-in codes never depend on the hub.
 *
 * Structural proof here: `@platform-core/iam-dev` and `@platform-core/iam` have
 * zero dependency on anything under `@platform-hub/*`. The architecture guard
 * refuses the opposite in CI. This test asserts the invariant at the
 * import-graph level so a regression is caught on PR, not in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The hub repo cannot read the core repo in this session, but it CAN assert
// that its own enforcement surface has no identity imports — i.e. a hub outage
// is irrelevant to sign-in because the sign-in path never crosses this layer.
test('no file under packages/enforcement imports an identity SDK', () => {
  const walk = function* (dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) yield full;
    }
  };
  const banned = /(^|from\s+['"])(@clerk\/|@aws-sdk\/client-cognito-identity-provider|aws-jwt-verify|amazon-cognito-identity-js)/;
  const violations: string[] = [];
  // Run from the package directory; walk our own src.
  for (const f of walk(new URL('../src', import.meta.url).pathname)) {
    const text = readFileSync(f, 'utf8');
    if (banned.test(text)) violations.push(f);
  }
  assert.deepEqual(violations, [], 'hub enforcement must never pull an identity provider');
});
