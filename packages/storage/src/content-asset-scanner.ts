export const CONTENT_ASSET_SCAN_VERDICTS = ['CLEAN', 'MALICIOUS', 'INDETERMINATE'] as const;
export type ContentAssetScanVerdict = (typeof CONTENT_ASSET_SCAN_VERDICTS)[number];

export interface ContentAssetScanRequest {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly objectReference: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly correlationId: string;
}

export interface ContentAssetScanResult {
  readonly assetId: string;
  readonly objectReference: string;
  readonly sha256: string;
  readonly verdict: ContentAssetScanVerdict;
  readonly reasonKey: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly signatureVersion: string;
  readonly scannedAt: string;
}

export interface ContentAssetScanner {
  scan(input: ContentAssetScanRequest): Promise<ContentAssetScanResult>;
}

export interface ContentAssetScannerTokenRequest {
  readonly tenantId: string;
  readonly assetId: string;
  readonly purpose: 'content-asset.malware-scan';
  readonly correlationId: string;
}

export type ContentAssetScannerTokenProvider = (
  input: ContentAssetScannerTokenRequest,
) => Promise<string>;

export interface HttpContentAssetScannerOptions {
  readonly endpoint: string;
  readonly accessToken: ContentAssetScannerTokenProvider;
  readonly fetchImpl?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function required(value: unknown, code: string, max = 255): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new Error(code);
  return value.trim();
}

/**
 * Platform-side adapter for a private scanning service. The service resolves the
 * opaque object reference through its own governed storage access; storage
 * credentials and object bytes are never exposed to Brand clients.
 */
export class HttpContentAssetScanner implements ContentAssetScanner {
  readonly #endpoint: string;
  readonly #accessToken: ContentAssetScannerTokenProvider;
  readonly #fetch: typeof fetch;

  constructor(options: HttpContentAssetScannerOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('CONTENT_ASSET_SCANNER_HTTPS_REQUIRED');
    if (endpoint.username !== '' || endpoint.password !== '') {
      throw new Error('CONTENT_ASSET_SCANNER_CREDENTIAL_IN_URL');
    }
    this.#endpoint = endpoint.toString();
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async scan(input: ContentAssetScanRequest): Promise<ContentAssetScanResult> {
    this.#validateRequest(input);
    const token = await this.#accessToken({
      tenantId: input.tenantId,
      assetId: input.assetId,
      purpose: 'content-asset.malware-scan',
      correlationId: input.correlationId,
    });
    if (token.trim() === '') throw new Error('CONTENT_ASSET_SCANNER_CREDENTIAL_UNAVAILABLE');

    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'X-Correlation-Id': input.correlationId,
      },
      body: JSON.stringify(input),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`CONTENT_ASSET_SCAN_PROVIDER_FAILED:${response.status}`);

    const value = await response.json() as Record<string, unknown>;
    const verdict = required(value.verdict, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 40);
    if (!(CONTENT_ASSET_SCAN_VERDICTS as readonly string[]).includes(verdict)) {
      throw new Error('CONTENT_ASSET_SCAN_RESPONSE_INVALID');
    }
    const result: ContentAssetScanResult = {
      assetId: required(value.assetId, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 64),
      objectReference: required(value.objectReference, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 500),
      sha256: required(value.sha256, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 64).toLowerCase(),
      verdict: verdict as ContentAssetScanVerdict,
      reasonKey: required(value.reasonKey, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 200),
      engine: required(value.engine, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 120),
      engineVersion: required(value.engineVersion, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 120),
      signatureVersion: required(value.signatureVersion, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 120),
      scannedAt: required(value.scannedAt, 'CONTENT_ASSET_SCAN_RESPONSE_INVALID', 64),
    };
    if (
      result.assetId !== input.assetId
      || result.objectReference !== input.objectReference
      || result.sha256 !== input.sha256.toLowerCase()
      || !SAFE_KEY.test(result.reasonKey)
      || Number.isNaN(new Date(result.scannedAt).getTime())
    ) {
      throw new Error('CONTENT_ASSET_SCAN_IDENTITY_MISMATCH');
    }
    return result;
  }

  #validateRequest(input: ContentAssetScanRequest): void {
    if (!UUID.test(input.tenantId) || !UUID.test(input.organizationId) || !UUID.test(input.assetId)) {
      throw new Error('CONTENT_ASSET_SCAN_SCOPE_INVALID');
    }
    const expected = `content-assets/${input.tenantId}/${input.organizationId}/${input.assetId}`;
    if (input.objectReference !== expected) throw new Error('CONTENT_ASSET_SCAN_REFERENCE_SCOPE_MISMATCH');
    if (!SHA256.test(input.sha256)) throw new Error('CONTENT_ASSET_SCAN_DIGEST_INVALID');
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) {
      throw new Error('CONTENT_ASSET_SCAN_BYTE_LENGTH_INVALID');
    }
    required(input.contentType, 'CONTENT_ASSET_SCAN_CONTENT_TYPE_INVALID');
    required(input.correlationId, 'CONTENT_ASSET_SCAN_CORRELATION_REQUIRED');
  }
}
