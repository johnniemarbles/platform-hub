import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from './provider-adapter.ts';

export interface TwilioCredentialRequest {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly idempotencyKey: string;
  readonly purpose: string;
  readonly requestedAt: string;
}

export type TwilioCredentialsProvider = (request: TwilioCredentialRequest) => Promise<{
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
}>;

export interface TwilioSmsWhatsappAdapterOptions {
  readonly credentials: TwilioCredentialsProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

interface TwilioAcceptedResponse {
  readonly sid?: unknown;
}

interface TwilioErrorResponse {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly more_info?: unknown;
}

export class TwilioSmsWhatsappAdapter implements CommunicationProviderAdapter {
  readonly adapterKey = 'twilio-sms-whatsapp-v1';
  readonly supportedChannels = ['sms', 'whatsapp'] as const;

  readonly #credentials: TwilioCredentialsProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;

  constructor(options: TwilioSmsWhatsappAdapterOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async send(request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult> {
    if (request.channel !== 'sms' && request.channel !== 'whatsapp') {
      return rejected('PROVIDER_REJECTED', 'Twilio sms-whatsapp adapter only supports sms and whatsapp.');
    }

    const phone = request.recipient.phone;
    if (typeof phone !== 'string' || phone.trim().length === 0) {
      return rejected('INVALID_RECIPIENT', 'A valid phone recipient is required.');
    }
    const to = request.channel === 'whatsapp' ? (phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`) : phone;

    const creds = await this.#credentials({
      tenantId: request.tenantId,
      ...(request.organizationId === undefined ? {} : { organizationId: request.organizationId }),
      triggerKey: request.triggerKey,
      idempotencyKey: request.idempotencyKey,
      purpose: request.purpose,
      requestedAt: request.requestedAt,
    });

    if (typeof creds.accountSid !== 'string' || creds.accountSid.trim().length === 0 || typeof creds.authToken !== 'string' || creds.authToken.trim().length === 0) {
      return rejected('AUTHENTICATION_FAILED', 'Provider credentials are unavailable.');
    }

    const from = creds.messagingServiceSid && creds.messagingServiceSid.trim().length > 0
      ? creds.messagingServiceSid
      : (request.sender?.address || request.sender?.senderKey);

    if (typeof from !== 'string' || from.trim().length === 0) {
      return rejected('SENDER_REJECTED', 'A verified sender or messaging service sid is required.');
    }

    const body = request.rendered.body;
    if (typeof body !== 'string' || body.trim().length === 0) {
      return rejected('PROVIDER_REJECTED', 'Message body is required.');
    }

    const auth = btoa(`${creds.accountSid}:${creds.authToken}`);
    
    const formData = new URLSearchParams();
    formData.append('To', to);
    if (creds.messagingServiceSid && creds.messagingServiceSid.trim().length > 0) {
        formData.append('MessagingServiceSid', from);
    } else {
        formData.append('From', request.channel === 'whatsapp' ? (from.startsWith('whatsapp:') ? from : `whatsapp:${from}`) : from);
    }
    formData.append('Body', body);

    const response = await this.#fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (response.status === 201) {
      const payload = await response.json().catch(() => null) as TwilioAcceptedResponse | null;
      if (typeof payload?.sid !== 'string' || payload.sid.trim().length === 0) {
        return {
          status: 'RETRYABLE_FAILURE',
          reasonCode: 'PROVIDER_UNAVAILABLE',
          reason: 'Provider acceptance response did not include a sid.',
        };
      }
      return {
        status: 'ACCEPTED',
        reasonCode: 'OK',
        providerMessageId: payload.sid,
        acceptedAt: this.#now(),
      };
    }

    if (response.status === 429) {
      return {
        status: 'RETRYABLE_FAILURE',
        reasonCode: 'RATE_LIMITED',
        reason: 'Provider rate limit reached.',
      };
    }

    const providerDetail = await twilioErrorDetail(response, request.channel);

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

    return rejected('PROVIDER_REJECTED', providerDetail ?? 'Provider rejected the request.');
  }
}

async function twilioErrorDetail(response: Response, channel: 'sms' | 'whatsapp'): Promise<string | null> {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let message = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as TwilioErrorResponse;
    const code = typeof parsed.code === 'number' || typeof parsed.code === 'string'
      ? `code ${parsed.code}`
      : '';
    const detail = typeof parsed.message === 'string' ? parsed.message : '';
    const moreInfo = typeof parsed.more_info === 'string' ? parsed.more_info : '';
    const candidate = [code, detail, moreInfo].filter((part) => part.trim().length > 0).join(' ');
    if (candidate.trim().length > 0) message = candidate.trim();
  } catch {
    // Twilio usually returns JSON, but retain a sanitized text body if it does not.
  }
  return `Twilio ${channel} rejected with HTTP ${response.status}: ${redactTwilioDetail(message)}`;
}

function redactTwilioDetail(value: string): string {
  return value
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/giu, 'Basic [redacted]')
    .replace(/AC[a-f0-9]{32}/giu, 'AC[redacted]')
    .replace(/SK[a-f0-9]{32}/giu, 'SK[redacted]')
    .replace(/MG[a-f0-9]{32}/giu, 'MG[redacted]')
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
