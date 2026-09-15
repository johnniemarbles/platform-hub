import { createHash } from 'node:crypto';
import type { SupabaseStorageAccessTokenProvider } from './supabase-artifact-store.ts';

export interface ContentAssetWriteInput {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly objectReference: string;
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
  readonly correlationId: string;
}

export interface ContentAssetWriteResult {
  readonly objectReference: string;
  readonly providerReference: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedAt: string;
}

export interface ContentAssetReadGrantInput {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly objectReference: string;
  readonly purpose: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
}

export interface ContentAssetReadGrant {
  readonly url: string;
  readonly expiresAt: string;
  readonly objectReference: string;
}

export interface ContentAssetBinaryStore {
  store(input: ContentAssetWriteInput): Promise<ContentAssetWriteResult>;
  issueReadGrant(input: ContentAssetReadGrantInput): Promise<ContentAssetReadGrant>;
}

export interface SupabaseContentAssetStoreOptions {
  readonly projectUrl: string;
  readonly bucket: string;
  readonly accessToken: SupabaseStorageAccessTokenProvider;
  readonly residencyTags: readonly string[];
  readonly complianceTags: readonly string[];
  readonly signedReadTtlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;

export class SupabaseContentAssetStore implements ContentAssetBinaryStore {
  readonly #projectUrl: string;
  readonly #bucket: string;
  readonly #accessToken: SupabaseStorageAccessTokenProvider;
  readonly #residencyTags: readonly string[];
  readonly #complianceTags: readonly string[];
  readonly #signedReadTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: SupabaseContentAssetStoreOptions) {
    const project = new URL(options.projectUrl);
    if (project.protocol !== 'https:') throw new Error('CONTENT_ASSET_PROJECT_URL_HTTPS_REQUIRED');
    if (!/^[A-Za-z0-9._-]+$/.test(options.bucket)) throw new Error('CONTENT_ASSET_BUCKET_INVALID');
    const ttl = options.signedReadTtlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 900) {
      throw new Error('CONTENT_ASSET_READ_TTL_INVALID');
    }
    this.#projectUrl = project.toString().replace(/\/+$/u, '');
    this.#bucket = options.bucket;
    this.#accessToken = options.accessToken;
    this.#residencyTags = [...options.residencyTags];
    this.#complianceTags = [...options.complianceTags];
    this.#signedReadTtlSeconds = ttl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async store(input: ContentAssetWriteInput): Promise<ContentAssetWriteResult> {
    this.#authorize(input.requiredResidencyTags, input.requiredComplianceTags);
    const path = this.#path(input);
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

    const token = await this.#token(input.tenantId, 'STORE', 'content-asset.write', input.correlationId);
    await this.#assertPrivateBucket(token);
    const response = await this.#fetch(this.#objectUrl(path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Content-Type': input.contentType,
        'x-upsert': 'false',
        'Cache-Control': 'no-store',
      },
      body: input.content,
      cache: 'no-store',
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      const duplicate = response.status === 409
        || (response.status === 400 && /already\s+exists|duplicate|resource\s+exists/iu.test(message));
      if (!duplicate) throw new Error(`CONTENT_ASSET_UPLOAD_FAILED:${response.status}`);
      const existing = await this.#readBytes(token, path);
      const existingSha = createHash('sha256').update(existing).digest('hex');
      if (existing.byteLength !== input.expectedByteLength || existingSha !== sha256) {
        throw new Error('CONTENT_ASSET_IMMUTABLE_REPLAY_CONFLICT');
      }
    }

    return {
      objectReference: input.objectReference,
      providerReference: `supabase-storage://${this.#bucket}/${path}`,
      byteLength: input.content.byteLength,
      sha256,
      storedAt: this.#instant().toISOString(),
    };
  }

  async issueReadGrant(input: ContentAssetReadGrantInput): Promise<ContentAssetReadGrant> {
    this.#authorize(input.requiredResidencyTags, input.requiredComplianceTags);
    const path = this.#path(input);
    const token = await this.#token(input.tenantId, 'SIGN', input.purpose, input.assetId);
    await this.#assertPrivateBucket(token);
    const response = await this.#fetch(this.#signUrl(path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ expiresIn: this.#signedReadTtlSeconds }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`CONTENT_ASSET_SIGN_FAILED:${response.status}`);
    const body = await response.json() as { signedURL?: unknown; signedUrl?: unknown };
    const raw = typeof body.signedURL === 'string'
      ? body.signedURL
      : typeof body.signedUrl === 'string'
        ? body.signedUrl
        : '';
    if (raw.trim() === '') throw new Error('CONTENT_ASSET_SIGN_RESPONSE_INVALID');
    const url = raw.startsWith('http')
      ? raw
      : `${this.#projectUrl}/storage/v1${raw.startsWith('/') ? '' : '/'}${raw}`;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.origin !== new URL(this.#projectUrl).origin) {
      throw new Error('CONTENT_ASSET_SIGN_RESPONSE_INVALID');
    }
    const now = this.#instant();
    return {
      url,
      objectReference: input.objectReference,
      expiresAt: new Date(now.getTime() + this.#signedReadTtlSeconds * 1000).toISOString(),
    };
  }

  #path(input: {
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

  async #readBytes(token: string, path: string): Promise<Uint8Array> {
    const response = await this.#fetch(this.#authenticatedObjectUrl(path), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: token,
        'Cache-Control': 'no-store',
      },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`CONTENT_ASSET_REPLAY_READ_FAILED:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
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
    if (!response.ok) throw new Error(`CONTENT_ASSET_BUCKET_VERIFICATION_FAILED:${response.status}`);
    const bucket = await response.json() as { id?: unknown; public?: unknown };
    if (bucket.id !== this.#bucket || bucket.public !== false) {
      throw new Error('CONTENT_ASSET_PRIVATE_BUCKET_REQUIRED');
    }
  }

  async #token(
    tenantId: string,
    operation: 'STORE' | 'SIGN',
    purpose: string,
    evidence: string,
  ): Promise<string> {
    const token = await this.#accessToken({
      tenantId,
      operation,
      purpose,
      idempotencyKey: `content-asset:${operation.toLowerCase()}:${createHash('sha256').update(evidence).digest('hex')}`,
      requestedAt: this.#instant().toISOString(),
    });
    if (token.trim() === '') throw new Error('CONTENT_ASSET_CREDENTIAL_UNAVAILABLE');
    return token;
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
}
