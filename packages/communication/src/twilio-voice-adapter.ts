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
      formData.append('StatusCallbackEvent', 'initiated ringing answered completed');
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

    return rejected('PROVIDER_REJECTED', 'Provider rejected the request.');
  }
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
