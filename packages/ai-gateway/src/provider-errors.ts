export type AiProviderFailureCode =
  | 'AI_PROVIDER_AUTH_FAILED'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_REQUEST_REJECTED'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_TEMPORARY_FAILURE'
  | 'AI_PROVIDER_NETWORK_FAILURE'
  | 'AI_PROVIDER_ERROR';

export class AiProviderError extends Error {
  readonly code: AiProviderFailureCode;
  readonly providerKey: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;

  constructor(input: {
    readonly code: AiProviderFailureCode;
    readonly providerKey: string;
    readonly httpStatus?: number;
    readonly retryable: boolean;
  }) {
    super(`${input.code}: ${input.providerKey} provider request failed.`);
    this.name = 'AiProviderError';
    this.code = input.code;
    this.providerKey = input.providerKey;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable;
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
  await response.body?.cancel().catch(() => undefined);
  throw classifyAiProviderStatus(providerKey, response.status);
}

export function classifyAiProviderStatus(
  providerKey: string,
  httpStatus: number,
): AiProviderError {
  if (httpStatus === 401 || httpStatus === 403) {
    return new AiProviderError({ code: 'AI_PROVIDER_AUTH_FAILED', providerKey, httpStatus, retryable: false });
  }
  if (httpStatus === 408) {
    return new AiProviderError({ code: 'AI_PROVIDER_TIMEOUT', providerKey, httpStatus, retryable: true });
  }
  if (httpStatus === 429) {
    return new AiProviderError({ code: 'AI_PROVIDER_RATE_LIMITED', providerKey, httpStatus, retryable: true });
  }
  if (httpStatus >= 500) {
    return new AiProviderError({ code: 'AI_PROVIDER_TEMPORARY_FAILURE', providerKey, httpStatus, retryable: true });
  }
  if (httpStatus >= 400) {
    return new AiProviderError({ code: 'AI_PROVIDER_REQUEST_REJECTED', providerKey, httpStatus, retryable: false });
  }
  return new AiProviderError({ code: 'AI_PROVIDER_ERROR', providerKey, httpStatus, retryable: false });
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
        reason: `${error.code}: ${error.providerKey} provider request failed.`,
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
  return { code, reason: `${code}: AI execution failed safely.`, retryable: false };
}
