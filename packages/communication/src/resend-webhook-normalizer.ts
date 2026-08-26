import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CommunicationProviderWebhookNormalizer,
  CommunicationProviderWebhookRequest,
  CommunicationProviderWebhookNormalizationResult,
  CommunicationProviderDeliveryEvent,
  CommunicationProviderWebhookState,
} from './provider-webhook.ts';

export interface ResendWebhookNormalizerOptions {
  readonly resolveSecret: (connectorKey: string) => Promise<string | undefined>;
}

export class ResendWebhookNormalizer implements CommunicationProviderWebhookNormalizer {
  readonly adapterKey = 'resend-email-v1';
  
  constructor(private readonly options: ResendWebhookNormalizerOptions) {}

  async verifyAndNormalize(
    request: CommunicationProviderWebhookRequest,
  ): Promise<CommunicationProviderWebhookNormalizationResult> {
    const svixId = this.getHeader(request.headers, 'svix-id');
    const svixTimestamp = this.getHeader(request.headers, 'svix-timestamp');
    const svixSignature = this.getHeader(request.headers, 'svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Missing Svix headers' };
    }

    const secret = await this.options.resolveSecret(request.connectorKey);
    if (!secret) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Missing webhook secret' };
    }

    const secretBytes = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice(6), 'base64')
      : Buffer.from(secret, 'utf8');

    const signedPayload = `${svixId}.${svixTimestamp}.${Buffer.from(request.rawBody).toString('utf8')}`;
    const expectedSignatureBytes = createHmac('sha256', secretBytes)
      .update(signedPayload)
      .digest();
    
    const passedSignatures = svixSignature.split(' ').map(s => s.split(','));
    let signatureMatched = false;
    for (const [version, sigBase64] of passedSignatures) {
      if (version === 'v1' && sigBase64) {
        const sigBytes = Buffer.from(sigBase64, 'base64');
        if (sigBytes.length === expectedSignatureBytes.length && timingSafeEqual(sigBytes, expectedSignatureBytes)) {
          signatureMatched = true;
          break;
        }
      }
    }

    if (!signatureMatched) {
      return { verified: false, reasonCode: 'WEBHOOK_SIGNATURE_INVALID', reason: 'Signature mismatch' };
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(request.rawBody).toString('utf8'));
    } catch (err) {
      return { verified: false, reasonCode: 'WEBHOOK_PAYLOAD_INVALID', reason: 'Invalid JSON' };
    }

    if (!payload || !payload.type || !payload.data || typeof payload.data.email_id !== 'string') {
      return { verified: false, reasonCode: 'WEBHOOK_PAYLOAD_INVALID', reason: 'Missing required payload fields' };
    }

    const state = this.mapState(payload.type);
    if (!state) {
      return { verified: true, events: [] };
    }

    const event: CommunicationProviderDeliveryEvent = {
      providerEventId: svixId,
      connectorKey: request.connectorKey,
      providerMessageId: payload.data.email_id,
      channel: 'email',
      state,
      occurredAt: payload.created_at || new Date().toISOString(),
      ...(payload.data.reason ? { reason: payload.data.reason } : {}),
    };

    return { verified: true, events: [event] };
  }

  private mapState(resendType: string): CommunicationProviderWebhookState | null {
    switch (resendType) {
      case 'email.sent': return 'SENT';
      case 'email.delivered': return 'DELIVERED';
      case 'email.bounced': return 'BOUNCED';
      case 'email.delivery_delayed': return 'FAILED'; // Map to FAILED for delayed/failed
      case 'email.complained': return 'COMPLAINED';
      default: return null;
    }
  }

  private getHeader(headers: Readonly<Record<string, string | readonly string[] | undefined>>, key: string): string | undefined {
    const val = headers[key] || headers[key.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val as string | undefined;
  }
}
