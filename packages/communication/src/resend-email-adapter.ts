import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from './provider-adapter.ts';

export interface ResendCredentialRequest {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly idempotencyKey: string;
  readonly purpose: CommunicationProviderSendRequest['purpose'];
  readonly requestedAt: string;
}

/**
 * Runtime-bound credential provider. A Resend adapter instance belongs to one
 * routed connector; this callback resolves that connector's short-lived secret
 * only at send time. Tokens never enter communication intent or delivery data.
 */
export type ResendApiTokenProvider = (request: ResendCredentialRequest) => Promise<string>;

export interface ResendEmailAdapterOptions {
  readonly apiToken: ResendApiTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

interface ResendAcceptedResponse {
  readonly id?: unknown;
}

interface ProviderErrorPayload {
  readonly message?: unknown;
  readonly error?: unknown;
  readonly name?: unknown;
}

export class ResendEmailAdapter implements CommunicationProviderAdapter {
  readonly adapterKey = 'resend-email-v1';
  readonly supportedChannels = ['email'] as const;

  readonly #apiToken: ResendApiTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: ResendEmailAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async send(request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult> {
    if (request.channel !== 'email') {
      return rejected('PROVIDER_REJECTED', 'Resend email adapter only supports email.');
    }

    const recipient = normalizedHeaderValue(request.recipient.email);
    if (recipient === null) {
      return rejected('INVALID_RECIPIENT', 'A valid email recipient is required.');
    }

    const senderAddress = normalizedHeaderValue(request.sender?.address);
    if (senderAddress === null) {
      return rejected('SENDER_REJECTED', 'A verified email sender is required.');
    }

    const subject = normalizedHeaderValue(request.rendered.subject ?? request.rendered.title);
    if (subject === null) {
      return rejected('PROVIDER_REJECTED', 'Email subject is required.');
    }

    if (!validIdempotencyKey(request.idempotencyKey)) {
      return rejected('PROVIDER_REJECTED', 'Email idempotency key is invalid.');
    }

    const token = await this.#apiToken({
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

    const from = formatSender(senderAddress, request.sender?.displayName);
    const replyTo = normalizedHeaderValue(request.sender?.replyTo);
    const content = request.rendered.format === 'HTML'
      ? { html: request.rendered.body }
      : { text: request.rendered.body };

    const response = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': request.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        ...(replyTo === null ? {} : { reply_to: replyTo }),
        ...content,
      }),
    });

    if (response.ok) {
      const payload = await response.json().catch(() => null) as ResendAcceptedResponse | null;
      if (typeof payload?.id !== 'string' || payload.id.trim().length === 0) {
        return {
          status: 'RETRYABLE_FAILURE',
          reasonCode: 'PROVIDER_UNAVAILABLE',
          reason: 'Provider acceptance response did not include a message id.',
        };
      }
      return {
        status: 'ACCEPTED',
        reasonCode: 'OK',
        providerMessageId: payload.id,
        acceptedAt: this.#now(),
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

    const providerDetail = await providerErrorDetail(response, 'email');

    if (response.status === 401 || response.status === 403) {
      return rejected('AUTHENTICATION_FAILED', providerDetail ?? 'Provider authentication failed.');
    }

    if (response.status >= 500) {
      return {
        status: 'RETRYABLE_FAILURE',
        reasonCode: 'PROVIDER_UNAVAILABLE',
        reason: providerDetail ?? 'Provider is temporarily unavailable.',
      };
    }

    return rejected('PROVIDER_REJECTED', providerDetail ?? 'Provider rejected the email request.');
  }
}

async function providerErrorDetail(response: Response, label: string): Promise<string | null> {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let message = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as ProviderErrorPayload;
    const candidate = [parsed.message, parsed.error, parsed.name]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');
    if (candidate.trim().length > 0) message = candidate.trim();
  } catch {
    // Non-JSON provider bodies are still useful diagnostics after redaction.
  }
  return `Resend ${label} rejected with HTTP ${response.status}: ${redactProviderDetail(message)}`;
}

function redactProviderDetail(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/giu, 'Basic [redacted]')
    .replace(/sk_[A-Za-z0-9._-]+/gu, 'sk_[redacted]')
    .slice(0, 500);
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

function normalizedHeaderValue(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0 || value !== value.trim()) return null;
  return /[\r\n]/u.test(value) ? null : value;
}

function formatSender(address: string, displayName: string | undefined): string {
  const name = normalizedHeaderValue(displayName);
  if (name === null) return address;
  return `${name.replace(/[<>]/gu, '')} <${address}>`;
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
