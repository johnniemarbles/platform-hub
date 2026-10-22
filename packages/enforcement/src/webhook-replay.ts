/**
 * Webhook replay protection, matching plan V3.1 §Reliability rules:
 * "provider webhooks: signature verified first, then replay checked, then the
 * tenant who owns that resource is confirmed; an ambiguous endpoint mapping is
 * rejected."
 *
 * Replay is detected by two independent checks (both must pass):
 *   1. Delivery ID (the provider's own event id, where available) has not been
 *      seen for this endpoint before.
 *   2. The signed timestamp is within a tolerance window of now.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { refusal, type Refusal } from '@platform-hub/contracts';

export interface WebhookDeliveryKey {
  readonly endpointId: string;    // which provider webhook endpoint received this
  readonly deliveryId: string;    // provider's own event id (Stripe event, Twilio message etc.)
}

export interface WebhookReplayStore {
  seen(key: WebhookDeliveryKey): Promise<boolean>;
  record(key: WebhookDeliveryKey, now: Date): Promise<void>;
}

export class InMemoryWebhookReplayStore implements WebhookReplayStore {
  readonly #keys = new Set<string>();
  readonly #id = (k: WebhookDeliveryKey) => `${k.endpointId}\u0000${k.deliveryId}`;
  async seen(k: WebhookDeliveryKey) { return this.#keys.has(this.#id(k)); }
  async record(k: WebhookDeliveryKey, _now: Date) { this.#keys.add(this.#id(k)); }
}

export interface WebhookVerifyOptions {
  readonly signature: string;            // what the provider sent (hex)
  readonly rawBody: string;              // exact bytes signed
  readonly secret: string;               // endpoint signing secret
  readonly signedTimestamp: number;      // seconds since epoch, from the provider
  readonly toleranceSeconds?: number;    // default 300
  readonly now?: () => Date;
  readonly traceId: string;
}

/** HMAC-SHA256 signature check used by Stripe, Razorpay, Twilio and the like. */
export function verifyWebhookSignature(options: WebhookVerifyOptions): true | Refusal {
  const tolerance = options.toleranceSeconds ?? 300;
  const nowSec = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - options.signedTimestamp) > tolerance) {
    return refusal('WEBHOOK_REPLAY', options.traceId);
  }
  const expected = createHmac('sha256', options.secret)
    .update(`${options.signedTimestamp}.${options.rawBody}`).digest('hex');
  const a = Buffer.from(options.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return refusal('WEBHOOK_SIGNATURE_INVALID', options.traceId);
  }
  return true;
}

export async function recordAndCheckReplay(
  key: WebhookDeliveryKey, store: WebhookReplayStore, now: Date, traceId: string,
): Promise<true | Refusal> {
  if (await store.seen(key)) return refusal('WEBHOOK_REPLAY', traceId);
  await store.record(key, now);
  return true;
}
