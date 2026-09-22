import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

import {
  CustodyFingerprintKeyError,
  credentialFingerprint,
  detectFingerprintCollisions,
  fingerprintsMatch,
  parseFingerprintKey,
} from '../src/fingerprint.ts';

const key = randomBytes(32);

test('fingerprint is stable for the same secret and key', () => {
  const a = credentialFingerprint('SK-live-abcdef0123456789', key);
  const b = credentialFingerprint('SK-live-abcdef0123456789', key);
  assert.equal(a, b);
  assert.match(a, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('fingerprint discloses no character of the secret (§2.3, prohibition C1)', () => {
  const secret = 'SK-live-abcdef0123456789';
  const fingerprint = credentialFingerprint(secret, key);
  for (let i = 0; i + 4 <= secret.length; i += 1) {
    assert.equal(fingerprint.includes(secret.slice(i, i + 4)), false);
  }
});

test('a different platform key produces a different fingerprint (HMAC, not a bare hash)', () => {
  const other = randomBytes(32);
  assert.notEqual(
    credentialFingerprint('same-secret', key),
    credentialFingerprint('same-secret', other),
  );
});

test('a short fingerprint key is rejected by HMAC, empty env is rejected by parse', () => {
  assert.throws(() => credentialFingerprint('secret', randomBytes(16)));
  assert.throws(() => parseFingerprintKey(undefined as never), CustodyFingerprintKeyError);
  assert.throws(() => parseFingerprintKey(''), CustodyFingerprintKeyError);
});

test('parseFingerprintKey accepts 64 hex or hashes a passphrase', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprintKey(hex).length, 32);
  assert.equal(parseFingerprintKey('railway-passphrase').length, 32);
  assert.notEqual(
    parseFingerprintKey('railway-passphrase').toString('hex'),
    parseFingerprintKey('other-passphrase').toString('hex'),
  );
});

test('the same fingerprint under two tenants is flagged (§2.3)', () => {
  const collisions = detectFingerprintCollisions([
    { fingerprint: 'K7QM-2F9X', tenantId: 'tenant-a', connectorKey: 'twilio-a' },
    { fingerprint: 'K7QM-2F9X', tenantId: 'tenant-b', connectorKey: 'twilio-b' },
    { fingerprint: 'P2WD-8H4K', tenantId: 'tenant-a', connectorKey: 'ses-a' },
  ]);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0]?.tenantIds, ['tenant-a', 'tenant-b']);
});

test('the same fingerprint twice under ONE tenant is not a collision', () => {
  const collisions = detectFingerprintCollisions([
    { fingerprint: 'K7QM-2F9X', tenantId: 'tenant-a', connectorKey: 'twilio-sms' },
    { fingerprint: 'K7QM-2F9X', tenantId: 'tenant-a', connectorKey: 'twilio-voice' },
  ]);
  assert.equal(collisions.length, 0);
});

test('fingerprint comparison is constant-time and length-safe', () => {
  assert.equal(fingerprintsMatch('K7QM-2F9X', 'K7QM-2F9X'), true);
  assert.equal(fingerprintsMatch('K7QM-2F9X', 'K7QM-2F9Y'), false);
  assert.equal(fingerprintsMatch('K7QM-2F9X', 'SHORT'), false);
});
