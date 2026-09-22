import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeObjectKey,
  presignUrl,
  sigV4Headers,
  uriEncode,
} from '../src/index.ts';

/**
 * The vectors below are AWS's own published worked examples for Signature
 * Version 4 with S3. They are the point of this file: a signer that is wrong
 * does not throw, it gets a 403 from a live service, so the only way to know
 * this code is correct before it faces a bucket is to reproduce a signature
 * someone else computed.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  host: 'examplebucket.s3.amazonaws.com',
  now: new Date('2013-05-24T00:00:00Z'),
} as const;

test('reproduces the published GET Object header signature', async () => {
  const headers = await sigV4Headers({
    ...AWS_EXAMPLE,
    method: 'GET',
    path: '/test.txt',
    headers: { Range: 'bytes=0-9' },
  });

  assert.equal(
    headers['authorization'],
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
});

test('reproduces the published PUT Object header signature', async () => {
  const headers = await sigV4Headers({
    ...AWS_EXAMPLE,
    method: 'PUT',
    path: '/test%24file.text',
    body: 'Welcome to Amazon S3.',
    headers: {
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
  });

  assert.equal(
    headers['authorization'],
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, '
      + 'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );
  assert.equal(
    headers['x-amz-content-sha256'],
    '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
  );
});

test('reproduces the published query-string (presigned) signature', () => {
  const { url, expiresAt } = presignUrl({
    ...AWS_EXAMPLE,
    method: 'GET',
    path: '/test.txt',
    expiresInSeconds: 86400,
  });

  assert.ok(
    url.endsWith('&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'),
    `unexpected signature in ${url}`,
  );
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?'));
  assert.equal(expiresAt, '2013-05-25T00:00:00.000Z');
});

test('a presigned URL carries a session token when one is held', () => {
  const { url } = presignUrl({
    ...AWS_EXAMPLE,
    method: 'GET',
    path: '/test.txt',
    expiresInSeconds: 300,
    sessionToken: 'session/token+value',
  });
  assert.match(url, /X-Amz-Security-Token=session%2Ftoken%2Bvalue/u);
});

test('refuses an expiry outside what S3 will honour', () => {
  for (const expiresInSeconds of [0, -1, 604801, 1.5]) {
    assert.throws(
      () => presignUrl({ ...AWS_EXAMPLE, method: 'GET', path: '/x', expiresInSeconds }),
      /SIGV4_PRESIGN_EXPIRY_INVALID/u,
    );
  }
});

test('refuses to sign without credentials', async () => {
  await assert.rejects(
    sigV4Headers({ ...AWS_EXAMPLE, accessKeyId: '  ', method: 'GET', path: '/x' }),
    /SIGV4_ACCESS_KEY_ID_REQUIRED/u,
  );
  await assert.rejects(
    sigV4Headers({ ...AWS_EXAMPLE, secretAccessKey: '', method: 'GET', path: '/x' }),
    /SIGV4_SECRET_ACCESS_KEY_REQUIRED/u,
  );
});

test('refuses a path that is not absolute', async () => {
  await assert.rejects(
    sigV4Headers({ ...AWS_EXAMPLE, method: 'GET', path: 'test.txt' }),
    /SIGV4_PATH_MUST_BE_ABSOLUTE/u,
  );
});

/**
 * S3 and everything else disagree about the path, and the disagreement is
 * invisible until a live service returns 403. A key containing a percent sign
 * is where the two rules diverge, so that is what this pins.
 */
test('encodes the path once for S3 and twice for other services', async () => {
  const forS3 = await sigV4Headers({
    ...AWS_EXAMPLE, method: 'GET', path: '/test%24file.text',
  });
  const forSes = await sigV4Headers({
    ...AWS_EXAMPLE, service: 'ses', host: 'email.us-east-1.amazonaws.com',
    method: 'GET', path: '/test%24file.text',
  });
  assert.notEqual(
    forS3['authorization']?.split('Signature=')[1],
    forSes['authorization']?.split('Signature=')[1],
  );
});

test('signs a plain SES request', async () => {
  const headers = await sigV4Headers({
    ...AWS_EXAMPLE,
    service: 'ses',
    host: 'email.us-east-1.amazonaws.com',
    method: 'GET',
    path: '/v2/email/account',
  });
  assert.match(
    headers['authorization'] ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/ses\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
  );
});

test('encodes the characters encodeURIComponent leaves behind', () => {
  assert.equal(uriEncode("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
  assert.equal(uriEncode('a b/c'), 'a%20b%2Fc');
  assert.equal(uriEncode('~-_.'), '~-_.');
});

test('an object key keeps its separators and loses nothing else', () => {
  assert.equal(
    encodeObjectKey('tenants/a b/content-assets/x!y.jpg'),
    'tenants/a%20b/content-assets/x%21y.jpg',
  );
});

test('query parameters are signed in byte order, not insertion order', async () => {
  const ordered = await sigV4Headers({
    ...AWS_EXAMPLE,
    method: 'GET',
    path: '/',
    query: { 'max-keys': '2', prefix: 'J' },
  });
  const shuffled = await sigV4Headers({
    ...AWS_EXAMPLE,
    method: 'GET',
    path: '/',
    query: { prefix: 'J', 'max-keys': '2' },
  });
  assert.equal(ordered['authorization'], shuffled['authorization']);
});
