import { createHash } from 'node:crypto';
import type {
  DurableArtifactReadContext,
  DurableArtifactSink,
  DurableArtifactSource,
  DurableArtifactWriteInput,
  DurableArtifactWriteResult,
  DurableArtifactTextReadResult,
  DurableArtifactProviderFetchResult,
} from './index.ts';

export type SupabaseStorageCredentialOperation = 'STORE' | 'READ' | 'SIGN';

export interface SupabaseStorageCredentialRequest {
  readonly tenantId: string;
  readonly operation: SupabaseStorageCredentialOperation;
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export type SupabaseStorageAccessTokenProvider =
  (request: SupabaseStorageCredentialRequest) => Promise<string>;

export interface SupabaseDurableArtifactStoreOptions {
  readonly projectUrl: string;
  readonly bucket: string;
  readonly accessToken: SupabaseStorageAccessTokenProvider;
  readonly residencyTags: readonly string[];
  readonly complianceTags: readonly string[];
  readonly signedUrlTtlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export class SupabaseDurableArtifactStore
implements DurableArtifactSink, DurableArtifactSource {
  readonly #projectUrl: string;
  readonly #bucket: string;
  readonly #accessToken: SupabaseStorageAccessTokenProvider;
  readonly #residencyTags: readonly string[];
  readonly #complianceTags: readonly string[];
  readonly #signedUrlTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: SupabaseDurableArtifactStoreOptions) {
    const project = new URL(options.projectUrl);
    if (project.protocol !== 'https:') {
      throw new Error('SUPABASE_STORAGE_PROJECT_URL_HTTPS_REQUIRED');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(options.bucket)) {
      throw new Error('SUPABASE_STORAGE_BUCKET_INVALID');
    }
    const ttl = options.signedUrlTtlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) {
      throw new Error('SUPABASE_STORAGE_SIGNED_URL_TTL_INVALID');
    }

    this.#projectUrl = project.toString().replace(/\/+$/u, '');
    this.#bucket = options.bucket;
    this.#accessToken = options.accessToken;
    this.#residencyTags = [...options.residencyTags];
    this.#complianceTags = [...options.complianceTags];
    this.#signedUrlTtlSeconds = ttl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async write(
    input: DurableArtifactWriteInput,
  ): Promise<DurableArtifactWriteResult> {
    this.#authorizeRequirements(
      input.requiredResidencyTags,
      input.requiredComplianceTags,
    );
    stable(input.tenantId, 'SUPABASE_STORAGE_TENANT_INVALID');
    stable(input.sourceId, 'SUPABASE_STORAGE_SOURCE_ID_INVALID');

    const bytes = typeof input.content === 'string'
      ? new TextEncoder().encode(input.content)
      : input.content;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = this.#artifactPath(input);
    const token = await this.#token(
      input.tenantId,
      'STORE',
      `artifact.write:${input.artifactKind}`,
      input.sourceId,
    );
    await this.#assertPrivateBucket(token);

    const response = await this.#fetch(this.#objectUrl(path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Content-Type': input.contentType,
        'x-upsert': 'false',
      },
      body: bytes,
    });

    if (response.ok) {
      return {
        contentReference: this.#reference(path),
        sha256,
        byteLength: bytes.byteLength,
      };
    }

    const uploadError = await response.text().catch(() => '');
    const duplicate =
      response.status === 409
      || (
        response.status === 400
        && /already\s+exists|duplicate|resource\s+exists/iu.test(uploadError)
      );

    if (duplicate) {
      const existing = await this.#readBytes({
        tenantId: input.tenantId,
        reference: this.#reference(path),
        purpose: `artifact-replay:${input.sourceId}`,
        requiredResidencyTags: input.requiredResidencyTags,
        requiredComplianceTags: input.requiredComplianceTags,
      });
      const existingSha = createHash('sha256')
        .update(existing.bytes)
        .digest('hex');
      if (existingSha === sha256) {
        return {
          contentReference: this.#reference(path),
          sha256,
          byteLength: bytes.byteLength,
        };
      }
      throw new Error('SUPABASE_STORAGE_IMMUTABLE_REPLAY_CONFLICT');
    }

    throw new Error(`SUPABASE_STORAGE_UPLOAD_FAILED:${response.status}`);
  }

  async readText(
    input: DurableArtifactReadContext,
  ): Promise<DurableArtifactTextReadResult> {
    const resolved = await this.#readBytes(input);
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(resolved.bytes),
      contentReference: resolved.contentReference,
    };
  }

  async issueProviderFetchUrl(
    input: DurableArtifactReadContext,
  ): Promise<DurableArtifactProviderFetchResult> {
    this.#authorizeRequirements(
      input.requiredResidencyTags,
      input.requiredComplianceTags,
    );
    const path = this.#pathFromReference(input.tenantId, input.reference);
    const token = await this.#token(
      input.tenantId,
      'SIGN',
      input.purpose,
      input.reference,
    );
    await this.#assertPrivateBucket(token);
    const response = await this.#fetch(this.#signUrl(path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: this.#signedUrlTtlSeconds }),
    });
    if (!response.ok) {
      throw new Error(`SUPABASE_STORAGE_SIGN_FAILED:${response.status}`);
    }
    const body = await response.json() as {
      signedURL?: unknown;
      signedUrl?: unknown;
    };
    const raw =
      typeof body.signedURL === 'string'
        ? body.signedURL
        : typeof body.signedUrl === 'string'
          ? body.signedUrl
          : '';
    if (raw.trim() === '') {
      throw new Error('SUPABASE_STORAGE_SIGN_RESPONSE_INVALID');
    }
    const providerFetchUrl = raw.startsWith('http')
      ? raw
      : `${this.#projectUrl}/storage/v1${raw.startsWith('/') ? '' : '/'}${raw}`;
    const parsed = new URL(providerFetchUrl);
    if (
      parsed.protocol !== 'https:'
      || parsed.origin !== new URL(this.#projectUrl).origin
    ) {
      throw new Error('SUPABASE_STORAGE_SIGN_RESPONSE_INVALID');
    }
    const now = this.#now();
    if (Number.isNaN(now.getTime())) {
      throw new Error('SUPABASE_STORAGE_CLOCK_INVALID');
    }
    return {
      providerFetchUrl,
      contentReference: this.#reference(path),
      expiresAt: new Date(
        now.getTime() + this.#signedUrlTtlSeconds * 1000,
      ).toISOString(),
    };
  }

  async #readBytes(
    input: DurableArtifactReadContext,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly contentReference: string;
  }> {
    this.#authorizeRequirements(
      input.requiredResidencyTags,
      input.requiredComplianceTags,
    );
    const path = this.#pathFromReference(input.tenantId, input.reference);
    const token = await this.#token(
      input.tenantId,
      'READ',
      input.purpose,
      input.reference,
    );
    await this.#assertPrivateBucket(token);
    const response = await this.#fetch(this.#authenticatedObjectUrl(path), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Cache-Control': 'no-store',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`SUPABASE_STORAGE_READ_FAILED:${response.status}`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentReference: this.#reference(path),
    };
  }

  async #assertPrivateBucket(token: string): Promise<void> {
    const response = await this.#fetch(this.#bucketUrl(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Cache-Control': 'no-store',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(
        `SUPABASE_STORAGE_BUCKET_VERIFICATION_FAILED:${response.status}`,
      );
    }
    const bucket = await response.json() as {
      readonly id?: unknown;
      readonly public?: unknown;
    };
    if (bucket.id !== this.#bucket || bucket.public !== false) {
      throw new Error('SUPABASE_STORAGE_PRIVATE_BUCKET_REQUIRED');
    }
  }

  async #token(
    tenantId: string,
    operation: SupabaseStorageCredentialOperation,
    purpose: string,
    evidenceKey: string,
  ): Promise<string> {
    const now = this.#now();
    if (Number.isNaN(now.getTime())) {
      throw new Error('SUPABASE_STORAGE_CLOCK_INVALID');
    }
    const evidenceHash = createHash('sha256')
      .update(evidenceKey)
      .digest('hex');
    const token = await this.#accessToken({
      tenantId,
      operation,
      purpose,
      idempotencyKey:
        `storage:${operation.toLowerCase()}:${evidenceHash}`,
      requestedAt: now.toISOString(),
    });
    if (token.trim() === '') {
      throw new Error('SUPABASE_STORAGE_CREDENTIAL_UNAVAILABLE');
    }
    return token;
  }

  #artifactPath(input: DurableArtifactWriteInput): string {
    const sourceHash = createHash('sha256')
      .update(input.sourceId)
      .digest('hex');
    return [
      'tenants',
      encodeURIComponent(input.tenantId),
      'execution-artifacts',
      input.sourceKind.toLowerCase(),
      input.artifactKind.toLowerCase(),
      sourceHash,
    ].join('/');
  }

  #pathFromReference(tenantId: string, reference: string): string {
    stable(tenantId, 'SUPABASE_STORAGE_TENANT_INVALID');
    const prefix = `supabase-storage://${this.#bucket}/`;
    if (!reference.startsWith(prefix)) {
      throw new Error('SUPABASE_STORAGE_REFERENCE_INVALID');
    }
    const path = reference.slice(prefix.length);
    const tenantPrefix = `tenants/${encodeURIComponent(tenantId)}/`;
    if (
      path.trim() === ''
      || path.includes('..')
      || !path.startsWith(tenantPrefix)
    ) {
      throw new Error('SUPABASE_STORAGE_REFERENCE_TENANT_MISMATCH');
    }
    return path;
  }

  #authorizeRequirements(
    residency: readonly string[],
    compliance: readonly string[],
  ): void {
    if (!residency.every((tag) => this.#residencyTags.includes(tag))) {
      throw new Error('SUPABASE_STORAGE_RESIDENCY_REQUIREMENT_UNSATISFIED');
    }
    if (!compliance.every((tag) => this.#complianceTags.includes(tag))) {
      throw new Error('SUPABASE_STORAGE_COMPLIANCE_REQUIREMENT_UNSATISFIED');
    }
  }

  #bucketUrl(): string {
    return `${this.#projectUrl}/storage/v1/bucket/${encodeURIComponent(this.#bucket)}`;
  }

  #objectUrl(path: string): string {
    return `${this.#projectUrl}/storage/v1/object/${encodeURIComponent(this.#bucket)}/${path}`;
  }

  #authenticatedObjectUrl(path: string): string {
    return `${this.#projectUrl}/storage/v1/object/authenticated/${encodeURIComponent(this.#bucket)}/${path}`;
  }

  #signUrl(path: string): string {
    return `${this.#projectUrl}/storage/v1/object/sign/${encodeURIComponent(this.#bucket)}/${path}`;
  }

  #reference(path: string): string {
    return `supabase-storage://${this.#bucket}/${path}`;
  }
}

function stable(value: string, code: string): void {
  if (
    value.trim() === ''
    || value !== value.trim()
    || /[\r\n\t]/u.test(value)
  ) {
    throw new Error(code);
  }
}
