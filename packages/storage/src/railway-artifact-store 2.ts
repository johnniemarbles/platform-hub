import { createHash } from 'node:crypto';
import { encodeObjectKey, presignUrl, sigV4Headers } from '@platform-hub/aws-sigv4';
import { RAILWAY_BUCKET_SCHEME } from './railway-content-asset-store.ts';
import type {
  DurableArtifactProviderFetchResult,
  DurableArtifactReadContext,
  DurableArtifactSink,
  DurableArtifactSource,
  DurableArtifactTextReadResult,
  DurableArtifactWriteInput,
  DurableArtifactWriteResult,
} from './index.ts';

export type ArtifactStorageCredentialOperation = 'STORE' | 'READ' | 'SIGN';

export interface ArtifactStorageCredentialRequest {
  readonly tenantId: string;
  readonly operation: ArtifactStorageCredentialOperation;
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

/**
 * Resolves the bucket credential for one operation.
 *
 * Still a single opaque string, because that is what the governed credential
 * lease issues and there is no reason to widen that machinery for this. An S3
 * credential is a pair, so the string is a JSON document holding both. Parsing
 * is strict: a credential that does not have exactly the expected shape is a
 * misconfiguration, and guessing at it would mean signing with half a key and
 * reading a 403 as an outage.
 */
export type ArtifactStorageCredentialProvider =
  (request: ArtifactStorageCredentialRequest) => Promise<string>;

export interface RailwayDurableArtifactStoreOptions {
  /** The bucket's S3 endpoint — Railway's `ENDPOINT`. */
  readonly endpoint: string;
  /** The globally unique S3 bucket name — Railway's `BUCKET`. */
  readonly bucket: string;
  /** Railway's `REGION`. */
  readonly region: string;
  readonly credentials: ArtifactStorageCredentialProvider;
  readonly residencyTags: readonly string[];
  readonly complianceTags: readonly string[];
  readonly signedUrlTtlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * Durable execution artifacts — AI output, transcripts, reasoning traces — in a
 * Railway storage bucket.
 *
 * Replaces the Supabase store, which could not work on this stack. As with
 * content assets, Railway buckets are private with no public mode, so the
 * per-write "is this bucket public?" check the Supabase store carried has no
 * equivalent and no need for one; what guards against being pointed somewhere
 * world-readable is that the endpoint is fixed by configuration.
 */
export class RailwayDurableArtifactStore
implements DurableArtifactSink, DurableArtifactSource {
  readonly #host: string;
  readonly #bucket: string;
  readonly #region: string;
  readonly #credentials: ArtifactStorageCredentialProvider;
  readonly #residencyTags: readonly string[];
  readonly #complianceTags: readonly string[];
  readonly #signedUrlTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: RailwayDurableArtifactStoreOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:') {
      throw new Error('ARTIFACT_STORAGE_ENDPOINT_HTTPS_REQUIRED');
    }
    if (endpoint.pathname !== '/' && endpoint.pathname !== '') {
      throw new Error('ARTIFACT_STORAGE_ENDPOINT_MUST_BE_ORIGIN');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('ARTIFACT_STORAGE_BUCKET_INVALID');
    }
    if (!/^[a-z0-9-]{1,32}$/.test(options.region)) {
      throw new Error('ARTIFACT_STORAGE_REGION_INVALID');
    }
    const ttl = options.signedUrlTtlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) {
      throw new Error('ARTIFACT_STORAGE_SIGNED_URL_TTL_INVALID');
    }
    this.#host = `${options.bucket}.${endpoint.host}`;
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#residencyTags = [...options.residencyTags];
    this.#complianceTags = [...options.complianceTags];
    this.#signedUrlTtlSeconds = ttl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async write(input: DurableArtifactWriteInput): Promise<DurableArtifactWriteResult> {
    this.#authorizeRequirements(input.requiredResidencyTags, input.requiredComplianceTags);
    stable(input.tenantId, 'ARTIFACT_STORAGE_TENANT_INVALID');
    stable(input.sourceId, 'ARTIFACT_STORAGE_SOURCE_ID_INVALID');

    const bytes = typeof input.content === 'string'
      ? new TextEncoder().encode(input.content)
      : input.content;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = this.#artifactKey(input);
    const credentials = await this.#credential(
      input.tenantId,
      'STORE',
      `artifact.write:${input.artifactKind}`,
      input.sourceId,
    );

    // An execution artifact is immutable: it is the record of what a provider
    // returned for one invocation. A second write under the same source id is
    // either the same bytes -- a replay, which is fine -- or a different
    // answer being passed off as that one, which is not.
    const existing = await this.#storedDigest(credentials, key);
    if (existing !== null) {
      if (existing !== sha256) throw new Error('ARTIFACT_STORAGE_IMMUTABLE_REPLAY_CONFLICT');
      return { contentReference: this.#reference(key), sha256, byteLength: bytes.byteLength };
    }

    const response = await this.#send(credentials, {
      method: 'PUT',
      key,
      headers: {
        'content-type': input.contentType,
        'content-length': String(bytes.byteLength),
        'if-none-match': '*',
        [DIGEST_METADATA_HEADER]: sha256,
      },
      body: bytes,
      payloadSha256: sha256,
    });

    if (!response.ok) {
      if (response.status === 412 || response.status === 409) {
        const raced = await this.#storedDigest(credentials, key);
        if (raced === null) throw new Error('ARTIFACT_STORAGE_UPLOAD_FAILED:412');
        if (raced !== sha256) throw new Error('ARTIFACT_STORAGE_IMMUTABLE_REPLAY_CONFLICT');
      } else {
        throw new Error(`ARTIFACT_STORAGE_UPLOAD_FAILED:${response.status}`);
      }
    }

    return { contentReference: this.#reference(key), sha256, byteLength: bytes.byteLength };
  }

  async readText(input: DurableArtifactReadContext): Promise<DurableArtifactTextReadResult> {
    this.#authorizeRequirements(input.requiredResidencyTags, input.requiredComplianceTags);
    const key = this.#keyFromReference(input.tenantId, input.reference);
    const credentials = await this.#credential(input.tenantId, 'READ', input.purpose, input.reference);
    const response = await this.#send(credentials, { method: 'GET', key });
    if (!response.ok) throw new Error(`ARTIFACT_STORAGE_READ_FAILED:${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      // Fatal decoding: an artifact that is not valid UTF-8 is not text, and
      // silently substituting replacement characters would corrupt the record.
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      contentReference: this.#reference(key),
    };
  }

  async issueProviderFetchUrl(
    input: DurableArtifactReadContext,
  ): Promise<DurableArtifactProviderFetchResult> {
    this.#authorizeRequirements(input.requiredResidencyTags, input.requiredComplianceTags);
    const key = this.#keyFromReference(input.tenantId, input.reference);
    const credentials = await this.#credential(input.tenantId, 'SIGN', input.purpose, input.reference);
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
      expiresInSeconds: this.#signedUrlTtlSeconds,
      now: this.#instant(),
    });
    return { providerFetchUrl: url, contentReference: this.#reference(key), expiresAt };
  }

  async #storedDigest(credentials: S3Credentials, key: string): Promise<string | null> {
    const response = await this.#send(credentials, { method: 'HEAD', key });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`ARTIFACT_STORAGE_HEAD_FAILED:${response.status}`);
    const digest = response.headers.get(DIGEST_METADATA_HEADER)?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('ARTIFACT_STORAGE_STORED_DIGEST_UNREADABLE');
    return digest;
  }

  async #send(
    credentials: S3Credentials,
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

  async #credential(
    tenantId: string,
    operation: ArtifactStorageCredentialOperation,
    purpose: string,
    evidence: string,
  ): Promise<S3Credentials> {
    const raw = await this.#credentials({
      tenantId,
      operation,
      purpose,
      idempotencyKey:
        `artifact:${operation.toLowerCase()}:${createHash('sha256').update(evidence).digest('hex')}`,
      requestedAt: this.#instant().toISOString(),
    });
    if (raw.trim() === '') throw new Error('ARTIFACT_STORAGE_CREDENTIAL_UNAVAILABLE');
    return parseS3Credential(raw);
  }

  #artifactKey(input: DurableArtifactWriteInput): string {
    const sourceHash = createHash('sha256').update(input.sourceId).digest('hex');
    return [
      'tenants',
      encodeURIComponent(input.tenantId),
      'execution-artifacts',
      input.sourceKind.toLowerCase(),
      input.artifactKind.toLowerCase(),
      sourceHash,
    ].join('/');
  }

  /**
   * A reference only resolves inside the tenant that owns it.
   *
   * This is the check that keeps one tenant's reference from reading another
   * tenant's artifact, so it is on the key prefix rather than on trust in the
   * caller.
   */
  #keyFromReference(tenantId: string, reference: string): string {
    stable(tenantId, 'ARTIFACT_STORAGE_TENANT_INVALID');
    const prefix = `${RAILWAY_BUCKET_SCHEME}${this.#bucket}/`;
    if (!reference.startsWith(prefix)) throw new Error('ARTIFACT_STORAGE_REFERENCE_INVALID');
    const key = reference.slice(prefix.length);
    const tenantPrefix = `tenants/${encodeURIComponent(tenantId)}/`;
    if (key.trim() === '' || key.includes('..') || !key.startsWith(tenantPrefix)) {
      throw new Error('ARTIFACT_STORAGE_REFERENCE_TENANT_MISMATCH');
    }
    return key;
  }

  #authorizeRequirements(residency: readonly string[], compliance: readonly string[]): void {
    if (!residency.every((tag) => this.#residencyTags.includes(tag))) {
      throw new Error('ARTIFACT_STORAGE_RESIDENCY_REQUIREMENT_UNSATISFIED');
    }
    if (!compliance.every((tag) => this.#complianceTags.includes(tag))) {
      throw new Error('ARTIFACT_STORAGE_COMPLIANCE_REQUIREMENT_UNSATISFIED');
    }
  }

  #instant(): Date {
    const now = this.#now();
    if (Number.isNaN(now.getTime())) throw new Error('ARTIFACT_STORAGE_CLOCK_INVALID');
    return now;
  }

  #reference(key: string): string {
    return `${RAILWAY_BUCKET_SCHEME}${this.#bucket}/${key}`;
  }
}

/** Lower-case: S3 lower-cases metadata keys on the way back out. */
const DIGEST_METADATA_HEADER = 'x-amz-meta-content-sha256';

/**
 * Reads the leased credential.
 *
 * Strict, and deliberately so: a credential missing its secret would otherwise
 * be signed with an empty key, and the resulting 403 would look like a storage
 * outage rather than a misconfiguration.
 */
export function parseS3Credential(raw: string): S3Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ARTIFACT_STORAGE_CREDENTIAL_MALFORMED');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARTIFACT_STORAGE_CREDENTIAL_MALFORMED');
  }
  const value = parsed as Record<string, unknown>;
  const accessKeyId = value.accessKeyId;
  const secretAccessKey = value.secretAccessKey;
  const sessionToken = value.sessionToken;
  if (
    typeof accessKeyId !== 'string' || accessKeyId.trim() === ''
    || typeof secretAccessKey !== 'string' || secretAccessKey.trim() === ''
  ) {
    throw new Error('ARTIFACT_STORAGE_CREDENTIAL_MALFORMED');
  }
  if (sessionToken !== undefined && (typeof sessionToken !== 'string' || sessionToken.trim() === '')) {
    throw new Error('ARTIFACT_STORAGE_CREDENTIAL_MALFORMED');
  }
  return {
    accessKeyId: accessKeyId.trim(),
    secretAccessKey: secretAccessKey.trim(),
    ...(typeof sessionToken === 'string' ? { sessionToken: sessionToken.trim() } : {}),
  };
}

function stable(value: string, code: string): void {
  if (value.trim() === '' || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error(code);
  }
}
