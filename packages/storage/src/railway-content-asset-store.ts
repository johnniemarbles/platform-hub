import { createHash } from 'node:crypto';
import { encodeObjectKey, presignUrl, sigV4Headers } from '@platform-hub/aws-sigv4';
import type {
  ContentAssetBinaryStore,
  ContentAssetReadGrant,
  ContentAssetReadGrantInput,
  ContentAssetWriteInput,
  ContentAssetWriteResult,
} from './content-asset-store.ts';

/**
 * Credentials for one bucket operation.
 *
 * Shaped as a call rather than a field so the same custody attribution the
 * Supabase store carried survives: who asked, for what purpose, under which
 * idempotency key. A store that reads a secret out of the environment loses
 * that record.
 */
export interface RailwayBucketCredentialRequest {
  readonly tenantId: string;
  readonly operation: 'STORE' | 'SIGN';
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface RailwayBucketCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export type RailwayBucketCredentialProvider =
  (request: RailwayBucketCredentialRequest) => Promise<RailwayBucketCredentials>;

export interface RailwayContentAssetStoreOptions {
  /** The bucket's S3 endpoint — Railway's `ENDPOINT`, e.g. https://t3.storageapi.dev */
  readonly endpoint: string;
  /** The globally unique S3 bucket name — Railway's `BUCKET`, not its display name. */
  readonly bucket: string;
  /** Railway's `REGION`, typically `auto`. */
  readonly region: string;
  readonly credentials: RailwayBucketCredentialProvider;
  readonly residencyTags: readonly string[];
  readonly complianceTags: readonly string[];
  readonly signedReadTtlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;

/** The header the digest is round-tripped in. Lower-case: S3 lower-cases metadata keys. */
const DIGEST_METADATA_HEADER = 'x-amz-meta-content-sha256';

export const RAILWAY_BUCKET_SCHEME = 'railway-bucket://';

/**
 * Content asset bytes in a Railway storage bucket.
 *
 * Railway buckets are S3-compatible and **private with no public mode**, which
 * changes one thing relative to the Supabase store this replaces: there is no
 * per-write check that the bucket has not been made world-readable, because
 * there is no such setting and no S3 call that would report it. The invariant
 * is held by the platform instead, and the safeguard that remains here is that
 * the endpoint is pinned by configuration — this store will not sign a request
 * to an arbitrary S3 host that *could* be public.
 */
export class RailwayContentAssetStore implements ContentAssetBinaryStore {
  readonly #host: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #credentials: RailwayBucketCredentialProvider;
  readonly #residencyTags: readonly string[];
  readonly #complianceTags: readonly string[];
  readonly #signedReadTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: RailwayContentAssetStoreOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('CONTENT_ASSET_ENDPOINT_HTTPS_REQUIRED');
    if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
      throw new Error('CONTENT_ASSET_ENDPOINT_MUST_BE_ORIGIN');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('CONTENT_ASSET_BUCKET_INVALID');
    }
    if (!/^[a-z0-9-]{1,32}$/.test(options.region)) throw new Error('CONTENT_ASSET_REGION_INVALID');
    const ttl = options.signedReadTtlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) {
      throw new Error('CONTENT_ASSET_READ_TTL_INVALID');
    }
    // Virtual-hosted style: the bucket is the subdomain. Railway's documented
    // URL style, and the one S3 clients assume.
    this.#host = `${options.bucket}.${endpoint.host}`;
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#residencyTags = [...options.residencyTags];
    this.#complianceTags = [...options.complianceTags];
    this.#signedReadTtlSeconds = ttl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async store(input: ContentAssetWriteInput): Promise<ContentAssetWriteResult> {
    this.#authorize(input.requiredResidencyTags, input.requiredComplianceTags);
    const key = this.#key(input);
    if (!Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength < 1) {
      throw new Error('CONTENT_ASSET_BYTE_LENGTH_INVALID');
    }
    if (input.content.byteLength !== input.expectedByteLength) {
      throw new Error('CONTENT_ASSET_BYTE_LENGTH_MISMATCH');
    }
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    if (!DIGEST.test(input.expectedSha256) || sha256 !== input.expectedSha256.toLowerCase()) {
      throw new Error('CONTENT_ASSET_DIGEST_MISMATCH');
    }
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.contentType)) {
      throw new Error('CONTENT_ASSET_CONTENT_TYPE_INVALID');
    }

    const credentials = await this.#credentials(
      this.#request(input.tenantId, 'STORE', 'content-asset.write', input.correlationId),
    );

    // Two guards against overwriting an asset that is already stored, because
    // a content asset is immutable once written. `If-None-Match: *` is the
    // authoritative one and closes the race; the digest comparison below is
    // what turns a rejected write into either a clean replay or a conflict.
    const existing = await this.#storedDigest(credentials, key);
    if (existing !== null) return this.#replay(existing, sha256, input, key);

    const response = await this.#send(credentials, {
      method: 'PUT',
      key,
      headers: {
        'content-type': input.contentType,
        'content-length': String(input.content.byteLength),
        'if-none-match': '*',
        [DIGEST_METADATA_HEADER]: sha256,
      },
      body: input.content,
      payloadSha256: sha256,
    });

    if (!response.ok) {
      if (response.status === 412 || response.status === 409) {
        const raced = await this.#storedDigest(credentials, key);
        if (raced === null) throw new Error('CONTENT_ASSET_UPLOAD_FAILED:412');
        return this.#replay(raced, sha256, input, key);
      }
      throw new Error(`CONTENT_ASSET_UPLOAD_FAILED:${response.status}`);
    }

    return {
      objectReference: input.objectReference,
      providerReference: `${RAILWAY_BUCKET_SCHEME}${this.#bucket}/${key}`,
      byteLength: input.content.byteLength,
      sha256,
      storedAt: this.#instant().toISOString(),
    };
  }

  async issueReadGrant(input: ContentAssetReadGrantInput): Promise<ContentAssetReadGrant> {
    this.#authorize(input.requiredResidencyTags, input.requiredComplianceTags);
    const key = this.#key(input);
    const credentials = await this.#credentials(
      this.#request(input.tenantId, 'SIGN', input.purpose, input.assetId),
    );
    const { url, expiresAt } = presignUrl({
      method: 'GET',
      host: this.#host,
      path: `/${encodeObjectKey(key)}`,
      region: this.#region,
      service: 's3',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken !== undefined
        ? { sessionToken: credentials.sessionToken }
        : {}),
      expiresInSeconds: this.#signedReadTtlSeconds,
      now: this.#instant(),
    });
    return { url, expiresAt, objectReference: input.objectReference };
  }

  /**
   * An object already at this key.
   *
   * Returns the digest recorded when it was written, or null when nothing is
   * there. A stored object with no recorded digest is not treated as absent —
   * overwriting it would destroy something we cannot identify.
   */
  async #storedDigest(
    credentials: RailwayBucketCredentials,
    key: string,
  ): Promise<string | null> {
    const response = await this.#send(credentials, { method: 'HEAD', key });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`CONTENT_ASSET_HEAD_FAILED:${response.status}`);
    const digest = response.headers.get(DIGEST_METADATA_HEADER)?.trim().toLowerCase() ?? '';
    if (!DIGEST.test(digest)) throw new Error('CONTENT_ASSET_STORED_DIGEST_UNREADABLE');
    return digest;
  }

  #replay(
    storedSha256: string,
    sha256: string,
    input: ContentAssetWriteInput,
    key: string,
  ): ContentAssetWriteResult {
    if (storedSha256 !== sha256) throw new Error('CONTENT_ASSET_IMMUTABLE_REPLAY_CONFLICT');
    return {
      objectReference: input.objectReference,
      providerReference: `${RAILWAY_BUCKET_SCHEME}${this.#bucket}/${key}`,
      byteLength: input.content.byteLength,
      sha256,
      storedAt: this.#instant().toISOString(),
    };
  }

  async #send(
    credentials: RailwayBucketCredentials,
    request: {
      readonly method: string;
      readonly key: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: Uint8Array;
      readonly payloadSha256?: string;
    },
  ): Promise<Response> {
    const path = `/${encodeObjectKey(request.key)}`;
    const signed = await sigV4Headers({
      method: request.method,
      host: this.#host,
      path,
      region: this.#region,
      service: 's3',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken !== undefined
        ? { sessionToken: credentials.sessionToken }
        : {}),
      ...(request.headers !== undefined ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.payloadSha256 !== undefined ? { payloadSha256: request.payloadSha256 } : {}),
      now: this.#instant(),
    });
    return this.#fetch(`https://${this.#host}${path}`, {
      method: request.method,
      headers: signed,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'error',
    });
  }

  #key(input: {
    readonly tenantId: string;
    readonly organizationId: string;
    readonly assetId: string;
    readonly objectReference: string;
  }): string {
    for (const [name, value] of [
      ['tenantId', input.tenantId],
      ['organizationId', input.organizationId],
      ['assetId', input.assetId],
    ] as const) {
      if (!UUID.test(value)) throw new Error(`CONTENT_ASSET_${name.toUpperCase()}_INVALID`);
    }
    const expected = `content-assets/${input.tenantId}/${input.organizationId}/${input.assetId}`;
    if (input.objectReference !== expected) throw new Error('CONTENT_ASSET_REFERENCE_SCOPE_MISMATCH');
    return `tenants/${input.tenantId}/organizations/${input.organizationId}/content-assets/${input.assetId}`;
  }

  #request(
    tenantId: string,
    operation: 'STORE' | 'SIGN',
    purpose: string,
    evidence: string,
  ): RailwayBucketCredentialRequest {
    return {
      tenantId,
      operation,
      purpose,
      idempotencyKey: `content-asset:${operation.toLowerCase()}:${createHash('sha256').update(evidence).digest('hex')}`,
      requestedAt: this.#instant().toISOString(),
    };
  }

  #authorize(residency: readonly string[], compliance: readonly string[]): void {
    if (!residency.every((tag) => this.#residencyTags.includes(tag))) {
      throw new Error('CONTENT_ASSET_RESIDENCY_REQUIREMENT_UNSATISFIED');
    }
    if (!compliance.every((tag) => this.#complianceTags.includes(tag))) {
      throw new Error('CONTENT_ASSET_COMPLIANCE_REQUIREMENT_UNSATISFIED');
    }
  }

  #instant(): Date {
    const now = this.#now();
    if (Number.isNaN(now.getTime())) throw new Error('CONTENT_ASSET_CLOCK_INVALID');
    return now;
  }
}

/**
 * Reads a stored provider reference back into its parts.
 *
 * Strict because this string decides what gets fetched: a reference that names
 * another bucket, or carries a traversal, must not resolve.
 */
export function parseRailwayBucketReference(
  reference: string,
): { bucket: string; key: string } {
  if (!reference.startsWith(RAILWAY_BUCKET_SCHEME)) {
    throw new Error('CONTENT_ASSET_REFERENCE_SCHEME_UNSUPPORTED');
  }
  const rest = reference.slice(RAILWAY_BUCKET_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error('CONTENT_ASSET_REFERENCE_INVALID');
  }
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('CONTENT_ASSET_REFERENCE_INVALID');
  }
  if (key.includes('..') || key.startsWith('/') || key.includes('\\') || /[\r\n\0]/.test(key)) {
    throw new Error('CONTENT_ASSET_REFERENCE_INVALID');
  }
  return { bucket, key };
}
