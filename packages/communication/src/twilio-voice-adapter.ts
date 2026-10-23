import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from './provider-adapter.ts';
import type { TwilioCredentialsProvider } from './twilio-sms-whatsapp-adapter.ts';
import {
  resolveTwilioVoiceSignalingUrl,
  resolveTwilioVoiceStatusCallbackUrl,
} from './twilio-voice-signaling.ts';

export interface TwilioVoiceAdapterOptions {
  readonly credentials: TwilioCredentialsProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly signalingBaseUrl?: string;
  readonly connectorKey?: string;
}

interface TwilioAcceptedResponse {
  readonly sid?: unknown;
}

interface TwilioErrorResponse {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly more_info?: unknown;
}

export class TwilioVoiceAdapter implements CommunicationProviderAdapter {
  readonly adapterKey = 'twilio-voice-v1';
  readonly supportedChannels = ['voice'] as const;

  readonly #credentials: TwilioCredentialsProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #signalingBaseUrl?: string;
  readonly #connectorKey?: string;

  constructor(options: TwilioVoiceAdapterOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.signalingBaseUrl !== undefined) this.#signalingBaseUrl = options.signalingBaseUrl;
    if (options.connectorKey !== undefined) this.#connectorKey = options.connectorKey;
  }

  async send(request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult> {
    if (request.channel !== 'voice') {
      return rejected('PROVIDER_REJECTED', 'Twilio voice adapter only supports voice.');
    }

    const phone = request.recipient.phone;
    if (typeof phone !== 'string' || phone.trim().length === 0) {
      return rejected('INVALID_RECIPIENT', 'A valid phone recipient is required.');
    }

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

    const from = request.sender?.address || request.sender?.senderKey;

    if (typeof from !== 'string' || from.trim().length === 0) {
      return rejected('SENDER_REJECTED', 'A verified sender phone number is required.');
    }

    const url = resolveTwilioVoiceSignalingUrl({
      renderedBody: request.rendered.body,
      tenantId: request.tenantId,
      ...(this.#connectorKey !== undefined ? { connectorKey: this.#connectorKey } : {}),
      ...(this.#signalingBaseUrl !== undefined ? { baseUrl: this.#signalingBaseUrl } : {}),
    });
    if (url === null) {
      return rejected('PROVIDER_REJECTED', 'Voice signaling URL is required in message body or EXPADIO_VOICE_TWIML_BASE.');
    }

    const auth = btoa(`${creds.accountSid}:${creds.authToken}`);

    const formData = new URLSearchParams();
    formData.append('To', phone);
    formData.append('From', from);
    formData.append('Url', url);
    const statusCallback = resolveTwilioVoiceStatusCallbackUrl({
      tenantId: request.tenantId,
      ...(this.#connectorKey !== undefined ? { connectorKey: this.#connectorKey } : {}),
      ...(this.#signalingBaseUrl !== undefined ? { baseUrl: this.#signalingBaseUrl } : {}),
    });
    if (statusCallback !== null) {
      formData.append('StatusCallback', statusCallback);
      formData.append('StatusCallbackMethod', 'POST');
      // REST expects the parameter repeated per event; a space-separated value
      // is TwiML attribute syntax and left calls without a hang-up callback.
      for (const event of ['initiated', 'ringing', 'answered', 'completed']) {
        formData.append('StatusCallbackEvent', event);
      }
    }

    const response = await this.#fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls.json`, {
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

    const providerDetail = await twilioErrorDetail(response);

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

async function twilioErrorDetail(response: Response): Promise<string | null> {
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
  return `Twilio voice rejected with HTTP ${response.status}: ${redactTwilioDetail(message)}`;
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
