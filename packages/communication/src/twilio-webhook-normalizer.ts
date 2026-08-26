import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CommunicationProviderWebhookNormalizer,
  CommunicationProviderWebhookRequest,
  CommunicationProviderWebhookNormalizationResult,
  CommunicationProviderDeliveryEvent,
  CommunicationProviderWebhookState,
} from './provider-webhook.ts';
import type { CommunicationChannel } from './index.ts';

export interface TwilioWebhookNormalizerOptions {
  readonly adapterKey: 'twilio-sms-whatsapp-v1' | 'twilio-voice-v1';
  readonly resolveAuthToken: (connectorKey: string) => Promise<string | undefined>;
  readonly getWebhookUrl: (request: CommunicationProviderWebhookRequest) => string;
}

export class TwilioWebhookNormalizer implements CommunicationProviderWebhookNormalizer {
  readonly adapterKey: string;
  readonly options: TwilioWebhookNormalizerOptions;

  constructor(options: TwilioWebhookNormalizerOptions) {
    this.options = options;
    this.adapterKey = options.adapterKey;
  }

  async verifyAndNormalize(
    request: CommunicationProviderWebhookRequest,
  ): Promise<CommunicationProviderWebhookNormalizationResult> {
    const signature = this.getHeader(request.headers, 'x-twilio-signature');
    if (!signature) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Missing X-Twilio-Signature' };
    }

    const authToken = await this.options.resolveAuthToken(request.connectorKey);
    if (!authToken) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Missing auth token' };
    }

    const bodyString = Buffer.from(request.rawBody).toString('utf8');
    const params = new URLSearchParams(bodyString);
    const paramObj: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      paramObj[key] = value;
    }

    const url = this.options.getWebhookUrl(request);
    
    // Twilio signature calculation: url + sorted(keys) + values
    const sortedKeys = Object.keys(paramObj).sort();
    let dataToSign = url;
    for (const key of sortedKeys) {
      dataToSign += key + paramObj[key];
    }

    const expectedSignature = createHmac('sha1', authToken)
      .update(dataToSign)
      .digest('base64');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Signature mismatch' };
    }

    let state: CommunicationProviderWebhookState | null = null;
    let providerMessageId: string | undefined = undefined;
    let channel: CommunicationChannel | undefined = undefined;

    if (paramObj.MessageStatus) {
      // SMS/WhatsApp
      state = this.mapSmsState(paramObj.MessageStatus);
      providerMessageId = paramObj.MessageSid;
      channel = 'sms';
    } else if (paramObj.CallStatus) {
      // Voice
      state = this.mapVoiceState(paramObj.CallStatus);
      providerMessageId = paramObj.CallSid;
      channel = 'voice';
    }

    if (!state) {
      return { verified: true, events: [] };
    }

    if (!providerMessageId) {
      return { verified: false, reasonCode: 'WEBHOOK_PAYLOAD_INVALID', reason: 'Missing provider message id' };
    }

    const event: CommunicationProviderDeliveryEvent = {
      providerEventId: paramObj.MessageSid || paramObj.CallSid || Math.random().toString(),
      connectorKey: request.connectorKey,
      providerMessageId,
      channel: channel as CommunicationChannel,
      state,
      occurredAt: new Date().toISOString(), // Twilio webhooks typically don't have a timestamp, fallback to now
    };

    if (paramObj.ErrorCode || paramObj.ErrorMessage) {
      (event as any).reasonCode = paramObj.ErrorCode;
      (event as any).reason = paramObj.ErrorMessage;
    }

    return { verified: true, events: [event] };
  }

  private mapSmsState(status: string): CommunicationProviderWebhookState | null {
    switch (status) {
      case 'sent': return 'SENT';
      case 'delivered': return 'DELIVERED';
      case 'undelivered':
      case 'failed': return 'FAILED';
      default: return null; // queued, sending, etc.
    }
  }

  private mapVoiceState(status: string): CommunicationProviderWebhookState | null {
    switch (status) {
      case 'completed': return 'DELIVERED';
      case 'failed':
      case 'busy':
      case 'no-answer':
      case 'canceled': return 'FAILED';
      default: return null; // queued, ringing, in-progress, etc.
    }
  }

  private getHeader(headers: Readonly<Record<string, string | readonly string[] | undefined>>, key: string): string | undefined {
    const val = headers[key] || headers[key.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val as string | undefined;
  }
}
