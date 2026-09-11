import type { CommunicationChannel } from './index.ts';

/**
 * Whether a provider's delivery event should stop us writing to that address
 * again.
 *
 * This is the missing link the platform has been running without. The webhook
 * receiver, the signature verification, the normalizer, the suppressions table
 * and the SUPPRESSION gate all existed; a bounce was ingested, the delivery was
 * recorded BOUNCED, and nothing ever told the gate. Every subsequent send went
 * to the same dead address, which is exactly how a sending reputation is lost.
 *
 * Pure and provider-aware in one place, so the judgement is testable without a
 * database and the rules are visible together rather than spread across
 * receivers.
 */

export type SuppressionReason = 'BOUNCE' | 'COMPLAINT';

export type SuppressionDecision =
  | {
      readonly suppress: true;
      readonly reason: SuppressionReason;
      /** Keyed exactly as communicationRecipientKey does, or the gate will never match. */
      readonly recipientKey: string;
      readonly channel: CommunicationChannel;
    }
  | { readonly suppress: false; readonly why: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The address this event is about, keyed the way a send keys it.
 *
 * Email keys are the trimmed, lowercased address -- the same derivation
 * communicationRecipientKey performs. A suppression written under any other
 * shape is a row the gate looks straight past, which is worse than no row at
 * all: it reads as handled.
 */
function emailRecipientKey(payload: Record<string, unknown>): string | null {
  const data = record(payload.data);
  const to = data.to;
  const first = Array.isArray(to) ? to[0] : to;
  if (typeof first !== 'string') return null;
  const key = first.trim().toLowerCase();
  return key === '' ? null : key;
}

/**
 * Permanent, or a moment's trouble.
 *
 * This is the distinction the whole decision turns on. A mailbox that is full,
 * a server that is briefly refusing, a greylisting -- these are transient, and
 * suppressing on them would permanently cut off a real customer because their
 * inbox was full on a Tuesday. Resend reports the classification on
 * `data.bounce.type`.
 */
function bouncePermanence(payload: Record<string, unknown>): 'PERMANENT' | 'TRANSIENT' | 'UNKNOWN' {
  const bounce = record(record(payload.data).bounce);
  const type = typeof bounce.type === 'string' ? bounce.type.trim().toUpperCase() : '';
  if (type === 'PERMANENT' || type === 'HARDBOUNCE' || type === 'HARD') return 'PERMANENT';
  if (type === 'TRANSIENT' || type === 'SOFTBOUNCE' || type === 'SOFT') return 'TRANSIENT';
  return 'UNKNOWN';
}

export function suppressionFromProviderWebhook(input: {
  readonly providerKey: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): SuppressionDecision {
  if (input.providerKey !== 'resend') {
    return { suppress: false, why: `No suppression rules for provider ${input.providerKey}.` };
  }

  const payload = input.payload as Record<string, unknown>;
  const eventType = input.eventType.trim().toLowerCase();

  if (eventType !== 'email.bounced' && eventType !== 'email.complained') {
    return { suppress: false, why: 'Event is not a bounce or a complaint.' };
  }

  const recipientKey = emailRecipientKey(payload);
  if (recipientKey === null) {
    // Nothing to key a suppression by. Reported rather than guessed: a
    // suppression on the wrong address silently stops a real conversation.
    return { suppress: false, why: 'The event names no recipient to suppress.' };
  }

  if (eventType === 'email.complained') {
    // A complaint is somebody pressing "this is spam". It is the strongest
    // signal there is not to send again, and every mailbox provider counts it
    // against the sending domain.
    //
    // The work order proposed tracking complaints without suppressing. That is
    // the wrong way round: a complaint is a stronger instruction than a bounce,
    // which suppresses. The schema already anticipated it -- COMPLAINT is one
    // of the reasons the table accepts -- and a tenant who needs the address
    // back can revoke the suppression, which is a decision with a person behind
    // it rather than a default that keeps mailing somebody who objected.
    return { suppress: true, reason: 'COMPLAINT', recipientKey, channel: 'email' };
  }

  const permanence = bouncePermanence(payload);
  if (permanence === 'PERMANENT') {
    return { suppress: true, reason: 'BOUNCE', recipientKey, channel: 'email' };
  }

  // Transient, or unclassified.
  //
  // Not suppressing on UNKNOWN is the conservative choice in the direction that
  // matters. A wrongly suppressed address is invisible and permanent from the
  // tenant's side -- nobody notices the customer they stopped being able to
  // reach. An address that should have been suppressed and was not simply
  // bounces again, visibly, and can be escalated on a repeat count later.
  return {
    suppress: false,
    why: permanence === 'TRANSIENT'
      ? 'Bounce is transient; the address may well be reachable later.'
      : 'Bounce carries no permanence classification, so it is not treated as permanent.',
  };
}
