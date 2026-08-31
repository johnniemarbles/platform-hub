import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from './provider-adapter.ts';

const UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';
const SYNTHETIC_ID = /^(linkedin|meta|x|threads|instagram|tiktok|youtube|bluesky|pinterest|google_business)-unreconciled-/;

export interface LinkedInSocialCredentialRequest {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly idempotencyKey: string;
  readonly purpose: CommunicationProviderSendRequest['purpose'];
  readonly requestedAt: string;
}

export type LinkedInAccessTokenProvider = (
  request: LinkedInSocialCredentialRequest,
) => Promise<string>;

export interface LinkedInSocialTextAdapterOptions {
  readonly accessToken: LinkedInAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

export class LinkedInSocialTextAdapter implements CommunicationProviderAdapter {
  readonly adapterKey = 'linkedin-social-text-v1';
  readonly supportedChannels = ['social'] as const;

  readonly #accessToken: LinkedInAccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: LinkedInSocialTextAdapterOptions) {
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async send(request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult> {
    if (request.channel !== 'social') {
      return rejected('PROVIDER_REJECTED', 'LinkedIn social text adapter only supports channel social.');
    }

    const body = normalizeText(request.rendered.body);
    if (body === null) {
      return rejected('PROVIDER_REJECTED', 'Social post body is required.');
    }

    const authorUrn = personUrn(request.recipient.subjectId);
    if (authorUrn === null) {
      return rejected('INVALID_RECIPIENT', 'LinkedIn person subjectId is required.');
    }

    if (!validIdempotencyKey(request.idempotencyKey)) {
      return rejected('PROVIDER_REJECTED', 'Social idempotency key is invalid.');
    }

    const token = await this.#accessToken({
      tenantId: request.tenantId,
      ...(request.organizationId === undefined ? {} : { organizationId: request.organizationId }),
      triggerKey: request.triggerKey,
      idempotencyKey: request.idempotencyKey,
      purpose: request.purpose,
      requestedAt: request.requestedAt,
    });
    if (!validToken(token)) {
      return rejected('AUTHENTICATION_FAILED', 'Provider credential is unavailable.');
    }

    const attemptedAt = this.#now();
    const response = await this.#fetch(UGC_POSTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(ugcTextPayload(authorUrn, body)),
    });

    if (response.ok) {
      const restliId = response.headers.get('x-restli-id');
      const id = acceptedIdentity(restliId);
      if (id === null) {
        return {
          status: 'RETRYABLE_FAILURE',
          reasonCode: 'PROVIDER_UNAVAILABLE',
          reason: 'Provider acceptance response did not include a message id.',
        };
      }
      return {
        status: 'ACCEPTED',
        reasonCode: 'OK',
        providerMessageId: id,
        acceptedAt: attemptedAt,
      };
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return {
        status: 'RETRYABLE_FAILURE',
        reasonCode: 'RATE_LIMITED',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        reason: 'Provider rate limit reached.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return rejected('AUTHENTICATION_FAILED', 'Provider authentication failed.');
    }

    if (response.status >= 500) {
      return {
        status: 'RETRYABLE_FAILURE',
        reasonCode: 'PROVIDER_UNAVAILABLE',
        reason: 'Provider is temporarily unavailable.',
      };
    }

    return rejected('PROVIDER_REJECTED', 'Provider rejected the social request.');
  }
}

export function personUrn(subjectId: string | undefined): string | null {
  if (subjectId === undefined) return null;
  if (subjectId.length === 0 || subjectId !== subjectId.trim()) return null;
  const value = subjectId.trim();
  if (/[\r\n\t ]/u.test(value)) return null;
  if (value.startsWith('urn:li:person:')) {
    return value.length > 'urn:li:person:'.length ? value : null;
  }
  if (/^urn:/u.test(value)) return null;
  return `urn:li:person:${value}`;
}

export function ugcTextPayload(authorUrn: string, text: string): unknown {
  return {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };
}

function acceptedIdentity(externalPostId: string | null | undefined): string | null {
  if (!externalPostId || externalPostId.trim().length === 0) return null;
  const id = externalPostId.trim();
  if (SYNTHETIC_ID.test(id)) return null;
  return id;
}

function rejected(
  reasonCode: Extract<
    CommunicationProviderSendResult['reasonCode'],
    'INVALID_RECIPIENT' | 'SENDER_REJECTED' | 'AUTHENTICATION_FAILED' | 'PROVIDER_REJECTED'
  >,
  reason: string,
): CommunicationProviderSendResult {
  return { status: 'REJECTED', reasonCode, reason };
}

function normalizeText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validToken(value: string): boolean {
  return value.length > 0 && value === value.trim() && !/[\r\n\t ]/u.test(value);
}

function validIdempotencyKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim() && !/[\r\n\t]/u.test(value);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
