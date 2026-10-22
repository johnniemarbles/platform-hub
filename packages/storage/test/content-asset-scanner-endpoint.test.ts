import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpContentAssetScanner } from '../src/content-asset-scanner.ts';

const accessToken = async () => 'token';

/**
 * The scanner is reached over Railway's private network, which does not do
 * TLS. Permitting plaintext there is what lets the service stay off the public
 * internet entirely — but only there, or the exception becomes the rule.
 */
test('accepts https anywhere and plain http only inside the private network', () => {
  for (const endpoint of [
    'https://scanner.example.com/scan',
    'http://content-asset-scanner.railway.internal:8080/scan',
    'http://railway.internal/scan',
  ]) {
    assert.doesNotThrow(() => new HttpContentAssetScanner({ endpoint, accessToken }), endpoint);
  }
});

test('refuses plaintext anywhere else, and a look-alike host', () => {
  for (const endpoint of [
    'http://scanner.example.com/scan',
    'http://localhost:8080/scan',
    // Ends with the string but not with the label: a different host entirely.
    'http://evilrailway.internal/scan',
    'http://railway.internal.evil.example/scan',
    'ftp://scanner.railway.internal/scan',
  ]) {
    assert.throws(
      () => new HttpContentAssetScanner({ endpoint, accessToken }),
      /CONTENT_ASSET_SCANNER_HTTPS_REQUIRED/u,
      `${endpoint} must be refused`,
    );
  }
});

test('refuses an endpoint carrying credentials', () => {
  assert.throws(
    () => new HttpContentAssetScanner({ endpoint: 'https://user:pass@scanner.example.com/scan', accessToken }),
    /CONTENT_ASSET_SCANNER_CREDENTIAL_IN_URL/u,
  );
});
