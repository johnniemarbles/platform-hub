import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH, createCipheriv, createHash, randomBytes } from 'node:crypto';

import { WrappingKeyStore, zeroise, type WrappedSecretEnvelope } from '../src/wrapping.ts';

function b64u(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mirrors the browser's wrapSecret() in ProviderOnboardingClient.tsx. */
function wrapLikeBrowser(secret: string, publicJwk: { x: string; y: string }, kid: string): WrappedSecretEnvelope {
  const x = Buffer.from(publicJwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const y = Buffer.from(publicJwk.y.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const recipient = Buffer.concat([Buffer.from([4]), x, y]);

  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(recipient);

  const aesKey = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), shared, Buffer.from('ECDH-ES+A256GCM', 'utf8')]))
    .digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return {
    kid,
    epk: b64u(ephemeral.getPublicKey()),
    iv: b64u(iv),
    ct: b64u(ct),
    tag: b64u(cipher.getAuthTag()),
  };
}

test('a browser-wrapped secret round-trips through the custody service (§2.2)', () => {
  const store = new WrappingKeyStore(120);
  const key = store.issue();
  const envelope = wrapLikeBrowser('super-secret-token', key.publicJwk, key.kid);

  const plaintext = store.unwrap(envelope);
  assert.equal(plaintext.toString('utf8'), 'super-secret-token');
});

test('a wrapping key is single use — no envelope replay', () => {
  const store = new WrappingKeyStore(120);
  const key = store.issue();
  const envelope = wrapLikeBrowser('token', key.publicJwk, key.kid);

  store.unwrap(envelope);
  assert.throws(() => store.unwrap(envelope), /CUSTODY_WRAPPING_KEY_UNKNOWN/);
});

test('an expired wrapping key refuses to unwrap', () => {
  const store = new WrappingKeyStore(30);
  const key = store.issue(0);
  const envelope = wrapLikeBrowser('token', key.publicJwk, key.kid);

  assert.throws(() => store.unwrap(envelope, 31_000), /CUSTODY_WRAPPING_KEY_EXPIRED/);
});

test('a tampered ciphertext fails the GCM auth tag rather than yielding garbage', () => {
  const store = new WrappingKeyStore(120);
  const key = store.issue();
  const envelope = wrapLikeBrowser('token', key.publicJwk, key.kid);
  const tampered = { ...envelope, ct: b64u(Buffer.from('tampered-ciphertext')) };

  assert.throws(() => store.unwrap(tampered), /CUSTODY_UNWRAP_FAILED/);
});

test('expired keys are evicted', () => {
  const store = new WrappingKeyStore(30);
  store.issue(0);
  store.issue(0);
  assert.equal(store.size, 2);
  assert.equal(store.evictExpired(31_000), 2);
  assert.equal(store.size, 0);
});

test('zeroise overwrites the buffer in place', () => {
  const buffer = Buffer.from('a-secret-value', 'utf8');
  zeroise(buffer);
  assert.equal(buffer.every((byte) => byte === 0), true);
});
