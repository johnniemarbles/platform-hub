export type AiProviderFailureCode =
  | 'AI_PROVIDER_AUTH_FAILED'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_REQUEST_REJECTED'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_TEMPORARY_FAILURE'
  | 'AI_PROVIDER_NETWORK_FAILURE'
  | 'AI_PROVIDER_ERROR';

export interface AiProviderRateLimitMetadata {
  readonly retryAfterSeconds?: number;
  readonly retryAfterRaw?: string;
  readonly limitRequests?: string;
  readonly remainingRequests?: string;
  readonly resetRequests?: string;
  readonly limitTokens?: string;
  readonly remainingTokens?: string;
  readonly resetTokens?: string;
}

export class AiProviderError extends Error {
  readonly code: AiProviderFailureCode;
  readonly providerKey: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  readonly rateLimit: AiProviderRateLimitMetadata | undefined;

  constructor(input: {
    readonly code: AiProviderFailureCode;
    readonly providerKey: string;
    readonly httpStatus?: number;
    readonly retryable: boolean;
    readonly rateLimit?: AiProviderRateLimitMetadata;
  }) {
    super(`${input.code}: ${input.providerKey} provider request failed.`);
    this.name = 'AiProviderError';
    this.code = input.code;
    this.providerKey = input.providerKey;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable;
    this.rateLimit = input.rateLimit;
  }
}

export async function fetchAiProvider(
  providerKey: string,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.name === 'AbortError' || error.name === 'TimeoutError');
    throw new AiProviderError({
      code: timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_NETWORK_FAILURE',
      providerKey,
      retryable: true,
    });
  }
  if (response.ok) return response;

  // Never materialize the provider response body into application errors,
  // durable events, queue rows, telemetry, or API responses.
  const rateLimit = extractRateLimitMetadata(response.headers);
  await response.body?.cancel().catch(() => undefined);
  throw classifyAiProviderStatus(providerKey, response.status, rateLimit);
}

export function classifyAiProviderStatus(
  providerKey: string,
  httpStatus: number,
  rateLimit?: AiProviderRateLimitMetadata,
): AiProviderError {
  if (httpStatus === 401 || httpStatus === 403) {
    return new AiProviderError({ code: 'AI_PROVIDER_AUTH_FAILED', providerKey, httpStatus, retryable: false });
  }
  if (httpStatus === 408) {
    return new AiProviderError({ code: 'AI_PROVIDER_TIMEOUT', providerKey, httpStatus, retryable: true });
  }
  if (httpStatus === 429) {
    return new AiProviderError({ code: 'AI_PROVIDER_RATE_LIMITED', providerKey, httpStatus, retryable: true, ...(rateLimit ? { rateLimit } : {}) });
  }
  if (httpStatus >= 500) {
    return new AiProviderError({ code: 'AI_PROVIDER_TEMPORARY_FAILURE', providerKey, httpStatus, retryable: true });
  }
  if (httpStatus >= 400) {
    return new AiProviderError({ code: 'AI_PROVIDER_REQUEST_REJECTED', providerKey, httpStatus, retryable: false });
  }
  return new AiProviderError({ code: 'AI_PROVIDER_ERROR', providerKey, httpStatus, retryable: false });
}

function extractRateLimitMetadata(headers: Headers): AiProviderRateLimitMetadata | undefined {
  const retryAfterRaw = headers.get('retry-after') ?? undefined;
  const retryAfterSeconds = retryAfterRaw === undefined ? undefined : parseRetryAfterSeconds(retryAfterRaw);
  const metadata: AiProviderRateLimitMetadata = {
    ...(retryAfterRaw === undefined ? {} : { retryAfterRaw }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...headerValue(headers, 'x-ratelimit-limit-requests', 'limitRequests'),
    ...headerValue(headers, 'x-ratelimit-remaining-requests', 'remainingRequests'),
    ...headerValue(headers, 'x-ratelimit-reset-requests', 'resetRequests'),
    ...headerValue(headers, 'x-ratelimit-limit-tokens', 'limitTokens'),
    ...headerValue(headers, 'x-ratelimit-remaining-tokens', 'remainingTokens'),
    ...headerValue(headers, 'x-ratelimit-reset-tokens', 'resetTokens'),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function headerValue<K extends keyof AiProviderRateLimitMetadata>(
  headers: Headers,
  headerName: string,
  key: K,
): Pick<AiProviderRateLimitMetadata, K> | Record<string, never> {
  const value = headers.get(headerName);
  return value === null ? {} : { [key]: value } as Pick<AiProviderRateLimitMetadata, K>;
}

function parseRetryAfterSeconds(value: string): number | undefined {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const parsedDate = Date.parse(value);
  if (!Number.isFinite(parsedDate)) return undefined;
  return Math.max(0, Math.ceil((parsedDate - Date.now()) / 1000));
}

function safeProviderFailureReason(error: AiProviderError): string {
  const parts = [`${error.code}: ${error.providerKey} provider request failed.`];
  if (error.httpStatus !== undefined) parts.push(`http_status=${error.httpStatus}`);
  if (error.rateLimit?.retryAfterSeconds !== undefined) {
    parts.push(`retry_after_seconds=${error.rateLimit.retryAfterSeconds}`);
  }
  if (error.rateLimit?.retryAfterRaw !== undefined) {
    parts.push(`retry_after=${error.rateLimit.retryAfterRaw}`);
  }
  if (error.rateLimit?.remainingRequests !== undefined) {
    parts.push(`remaining_requests=${error.rateLimit.remainingRequests}`);
  }
  if (error.rateLimit?.resetRequests !== undefined) {
    parts.push(`reset_requests=${error.rateLimit.resetRequests}`);
  }
  if (error.rateLimit?.remainingTokens !== undefined) {
    parts.push(`remaining_tokens=${error.rateLimit.remainingTokens}`);
  }
  if (error.rateLimit?.resetTokens !== undefined) {
    parts.push(`reset_tokens=${error.rateLimit.resetTokens}`);
  }
  return parts.join(' ');
}

export function safeAiFailure(error: unknown): {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
} {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('AI_')) {
    if (error instanceof AiProviderError) {
      return {
        code: error.code,
        reason: safeProviderFailureReason(error),
        retryable: error.retryable,
      };
    }
    const message = 'message' in error && typeof error.message === 'string' ? error.message : `${error.code}: AI execution failed.`;
    return {
      code: error.code,
      reason: message.startsWith(error.code) ? message : `${error.code}: ${message}`,
      retryable: false,
    };
  }
  const safeCode = error instanceof Error
    ? /^([A-Z][A-Z0-9_]{2,80})(?::|$)/u.exec(error.message)?.[1]
    : undefined;
  const code = safeCode?.startsWith('AI_') ? safeCode : 'AI_EXECUTION_FAILED';
  return { code, reason: `${code}: AI execution failed.`, retryable: false };
}
