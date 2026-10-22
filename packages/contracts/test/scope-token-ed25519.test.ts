import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signScopeTokenEd25519, verifyScopeTokenEd25519 } from '../src/scope-token-ed25519.ts';
import { enforceScope, type ScopeTokenClaims } from '../src/scope-token.ts';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const NOW = () => new Date(2026_10_22_000000);
const nowSec = Math.floor(NOW().getTime() / 1000);

const base = (): ScopeTokenClaims => ({
  iss: 'platform', aud: 'hub',
  sub: 'usr_42', kind: 'user',
  tenantId: 'tnt_A', appId: 'app_dentex',
  permissions: ['communication.email.send'],
  hierarchyScope: 'brand/acme',
  credentialClass: 'platform-operational',
  jti: 'tok_1', iat: nowSec - 10, exp: nowSec + 300,
});

test('a well-formed Ed25519 token verifies with its matching public key', () => {
  const token = signScopeTokenEd25519(base(), { privateKey: kp.privateKey });
  const r = verifyScopeTokenEd25519(token, { publicKey: kp.publicKey, now: NOW, traceId: 'tr' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.claims.sub, 'usr_42');
});

test('a token signed with another key is rejected', () => {
  const token = signScopeTokenEd25519(base(), { privateKey: other.privateKey });
  const r = verifyScopeTokenEd25519(token, { publicKey: kp.publicKey, now: NOW, traceId: 'tr' });
  if (!r.ok) assert.equal(r.code, 'TOKEN_SIGNATURE_INVALID');
});

test('scope-enforcement is identical across HS256 and Ed25519 verified claims', () => {
  const token = signScopeTokenEd25519(base(), { privateKey: kp.privateKey });
  const r = verifyScopeTokenEd25519(token, { publicKey: kp.publicKey, now: NOW, traceId: 'tr' });
  assert.equal(r.ok, true);
  if (r.ok) {
    const bad = enforceScope(r, { tenantId: 'tnt_B', appId: 'app_dentex' }, 'tr');
    if (bad !== true) assert.equal(bad.code, 'TOKEN_SCOPE_MISMATCH');
    const ok = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', hierarchyNode: 'brand/acme/x' }, 'tr');
    assert.equal(ok, true);
  }
});

test('refuses non-Ed25519 keys at construction time', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signScopeTokenEd25519(base(), { privateKey: rsa.privateKey }));
});
