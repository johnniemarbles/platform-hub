import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signScopeToken, verifyScopeToken, enforceScope,
  SCOPE_TOKEN_SECRET_MIN_BYTES, type ScopeTokenClaims,
} from '../src/scope-token.ts';

const SECRET = 'a'.repeat(SCOPE_TOKEN_SECRET_MIN_BYTES);
const NOW = () => new Date(2026_10_22_000000);
const nowSec = Math.floor(NOW().getTime() / 1000);

const base = (): ScopeTokenClaims => ({
  iss: 'platform', aud: 'hub',
  sub: 'usr_42', kind: 'user',
  tenantId: 'tnt_A', appId: 'app_dentex',
  permissions: ['communication.email.send'],
  hierarchyScope: 'brand/acme',
  credentialClass: 'platform-operational',
  jti: 'tok_1',
  iat: nowSec - 10, exp: nowSec + 300,
});

const sign = (overrides: Partial<ScopeTokenClaims> = {}) => signScopeToken({ ...base(), ...overrides }, SECRET);
const verify = (token: string, traceId = 'tr_1') => verifyScopeToken(token, { secret: SECRET, now: NOW, traceId });

test('a well-formed scope token verifies and surfaces its claims', () => {
  const result = verify(sign());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.claims.sub, 'usr_42');
});

test('a token signed with another secret is rejected (TOKEN_SIGNATURE_INVALID)', () => {
  const token = signScopeToken(base(), 'b'.repeat(SCOPE_TOKEN_SECRET_MIN_BYTES));
  const r = verify(token);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'TOKEN_SIGNATURE_INVALID');
});

test('an expired token is rejected (TOKEN_EXPIRED)', () => {
  const token = sign({ exp: nowSec - 1 });
  const r = verify(token);
  if (!r.ok) assert.equal(r.code, 'TOKEN_EXPIRED');
});

test('a token issued by the wrong party is rejected', () => {
  const r = verify(sign({ iss: 'rogue' }));
  if (!r.ok) assert.equal(r.code, 'TOKEN_WRONG_ISSUER');
});

test('a token minted for someone else is rejected (TOKEN_WRONG_AUDIENCE)', () => {
  const r = verify(sign({ aud: 'another-service' }));
  if (!r.ok) assert.equal(r.code, 'TOKEN_WRONG_AUDIENCE');
});

test('BYOK and provisioned classes require a grantId at sign time', () => {
  assert.throws(() => signScopeToken({ ...base(), credentialClass: 'tenant-byok' }, SECRET));
  assert.throws(() => signScopeToken({ ...base(), credentialClass: 'platform-provisioned' }, SECRET));
  assert.doesNotThrow(() => signScopeToken({ ...base(), credentialClass: 'tenant-byok', grantId: 'gr_1' }, SECRET));
});

test('enforceScope: tenant A token cannot act on tenant B (plan acceptance test)', () => {
  const r = verify(sign({ tenantId: 'tnt_A' }));
  assert.equal(r.ok, true);
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_B', appId: 'app_dentex' }, 'tr_1');
    assert.notEqual(scope, true);
    if (scope !== true) assert.equal(scope.code, 'TOKEN_SCOPE_MISMATCH');
  }
});

test('enforceScope: app A credentials cannot act for app B', () => {
  const r = verify(sign({ appId: 'app_dentex' }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_insurance' }, 'tr_1');
    if (scope !== true) assert.equal(scope.code, 'TOKEN_SCOPE_MISMATCH');
  }
});

test('enforceScope: a user outside their hierarchy scope is denied', () => {
  const r = verify(sign({ hierarchyScope: 'brand/acme' }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', hierarchyNode: 'brand/other' }, 'tr_1');
    if (scope !== true) assert.equal(scope.code, 'TOKEN_SCOPE_MISMATCH');
  }
});

test('enforceScope: a child node under the token\'s hierarchy scope is allowed', () => {
  const r = verify(sign({ hierarchyScope: 'brand/acme' }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', hierarchyNode: 'brand/acme/location/42' }, 'tr_1');
    assert.equal(scope, true);
  }
});

test('enforceScope: no key fallback — mismatched credential class is CREDENTIAL_CLASS_FORBIDDEN', () => {
  const r = verify(sign({ credentialClass: 'platform-operational' }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', credentialClass: 'tenant-byok' }, 'tr_1');
    if (scope !== true) assert.equal(scope.code, 'CREDENTIAL_CLASS_FORBIDDEN');
  }
});

test('enforceScope: a grant that was never issued cannot be exercised', () => {
  const r = verify(sign({ credentialClass: 'tenant-byok', grantId: 'gr_1' }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', credentialClass: 'tenant-byok', grantId: 'gr_2' }, 'tr_1');
    if (scope !== true) assert.equal(scope.code, 'CREDENTIAL_NOT_GRANTED');
  }
});

test('enforceScope: a permission the token did not carry is rejected', () => {
  const r = verify(sign({ permissions: ['communication.email.send'] }));
  if (r.ok) {
    const scope = enforceScope(r, { tenantId: 'tnt_A', appId: 'app_dentex', permission: 'payments.charge.create' }, 'tr_1');
    if (scope !== true) assert.equal(scope.code, 'TOKEN_SCOPE_MISMATCH');
  }
});

test('garbage tokens are rejected safely with TOKEN_MALFORMED or TOKEN_SIGNATURE_INVALID', () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', 'a.b.c']) {
    const r = verify(bad);
    assert.equal(r.ok, false);
  }
});
