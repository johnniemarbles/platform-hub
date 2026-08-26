export * from './conversation.ts';
export * from './suppression.ts';
export * from './consent.ts';
export * from './template.ts';

export type CommunicationChannel =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'voice'
  | 'in_app'
  | 'push'
  | 'rcs';

export type CommunicationPurpose = 'transactional' | 'marketing' | 'system';

export type CommunicationAddressKind = 'email' | 'phone' | 'whatsapp' | 'subject' | 'push';

export interface CommunicationChannelMetadata {
  readonly channel: CommunicationChannel;
  readonly addressKind: CommunicationAddressKind;
  readonly requiresConsent: boolean;
  readonly supportsSuppression: boolean;
}

const CHANNELS: Readonly<Record<CommunicationChannel, CommunicationChannelMetadata>> = {
  email: { channel: 'email', addressKind: 'email', requiresConsent: false, supportsSuppression: true },
  sms: { channel: 'sms', addressKind: 'phone', requiresConsent: true, supportsSuppression: true },
  whatsapp: { channel: 'whatsapp', addressKind: 'whatsapp', requiresConsent: true, supportsSuppression: true },
  voice: { channel: 'voice', addressKind: 'phone', requiresConsent: true, supportsSuppression: true },
  in_app: { channel: 'in_app', addressKind: 'subject', requiresConsent: false, supportsSuppression: false },
  push: { channel: 'push', addressKind: 'push', requiresConsent: true, supportsSuppression: true },
  rcs: { channel: 'rcs', addressKind: 'phone', requiresConsent: true, supportsSuppression: true },
};

export function communicationChannelMetadata(channel: CommunicationChannel): CommunicationChannelMetadata {
  return CHANNELS[channel];
}

export function listCommunicationChannels(): readonly CommunicationChannelMetadata[] {
  return Object.values(CHANNELS);
}

export interface CommunicationRecipient {
  readonly subjectId?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly whatsapp?: string;
  readonly pushEndpoint?: string;
}

export interface CommunicationIntent {
  readonly triggerKey: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly recipient: CommunicationRecipient;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly locale?: string;
  readonly idempotencyKey: string;
  readonly purpose: CommunicationPurpose;
  readonly consentRequired: boolean;
  readonly channel?: CommunicationChannel;
}

export type CommunicationDispatchState = 'QUEUED' | 'SENT' | 'REFUSED';

export type CommunicationDispatchReasonCode =
  | 'OK'
  | 'CONSENT_MISSING'
  | 'SUPPRESSED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TEMPLATE_MISSING'
  | 'RATE_LIMITED'
  | 'RESIDENCY_BLOCKED'
  | 'SENDER_UNVERIFIED'
  | 'QUIET_HOURS'
  | 'THROTTLED'
  | 'GOVERNANCE_BLOCKED'
  | 'NOT_CONFIGURED'
  | 'INVALID_RECIPIENT';

export interface CommunicationDispatchResult {
  readonly state: CommunicationDispatchState;
  readonly reasonCode: CommunicationDispatchReasonCode;
  readonly messageId: string | null;
  readonly providerKey?: string;
  readonly refusalReason?: string;
  readonly queuedAt?: string;
}

export type CommunicationDeliveryStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'READ'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface CommunicationDeliveryUpdate {
  readonly messageId: string;
  readonly channel: CommunicationChannel;
  readonly status: CommunicationDeliveryStatus;
  readonly occurredAt: string;
  readonly providerKey?: string;
  readonly providerMessageId?: string;
  readonly reasonCode?: string;
}

export type CommunicationSuppressionReason =
  | 'BOUNCE'
  | 'COMPLAINT'
  | 'OPT_OUT'
  | 'LEGAL_HOLD'
  | 'UNSUBSCRIBE';

export interface CommunicationSuppression {
  readonly reason: CommunicationSuppressionReason;
}

export interface CommunicationPreflightInput {
  readonly intent: CommunicationIntent;
  readonly channel: CommunicationChannel;
  readonly consentGranted?: boolean;
  readonly suppression?: CommunicationSuppression;
}

export interface CommunicationPreflightDecision {
  readonly allowed: boolean;
  readonly reasonCode: Extract<
    CommunicationDispatchReasonCode,
    'OK' | 'CONSENT_MISSING' | 'SUPPRESSED' | 'INVALID_RECIPIENT'
  >;
  readonly reason: string;
}

export function evaluateCommunicationPreflight(
  input: CommunicationPreflightInput,
): CommunicationPreflightDecision {
  const metadata = communicationChannelMetadata(input.channel);

  if (!recipientSupportsChannel(input.intent.recipient, input.channel)) {
    return {
      allowed: false,
      reasonCode: 'INVALID_RECIPIENT',
      reason: `Recipient is not addressable through ${input.channel}.`,
    };
  }

  const consentRequired = input.intent.consentRequired || metadata.requiresConsent;
  if (consentRequired && input.consentGranted !== true) {
    return {
      allowed: false,
      reasonCode: 'CONSENT_MISSING',
      reason: `Consent is required for ${input.channel}.`,
    };
  }

  if (metadata.supportsSuppression && input.suppression !== undefined) {
    return {
      allowed: false,
      reasonCode: 'SUPPRESSED',
      reason: `Recipient is suppressed for ${input.channel}: ${input.suppression.reason}.`,
    };
  }

  return {
    allowed: true,
    reasonCode: 'OK',
    reason: 'Communication preflight passed.',
  };
}

export type CommunicationIntentIdentityErrorCode =
  | 'TRIGGER_REQUIRED'
  | 'TENANT_REQUIRED'
  | 'IDEMPOTENCY_REQUIRED'
  | 'RECIPIENT_REQUIRED'
  | 'CHANNEL_RECIPIENT_MISMATCH';

export class CommunicationIntentIdentityError extends Error {
  readonly code: CommunicationIntentIdentityErrorCode;

  constructor(code: CommunicationIntentIdentityErrorCode, message: string) {
    super(message);
    this.name = 'CommunicationIntentIdentityError';
    this.code = code;
  }
}

export interface ResolvedCommunicationIntentIdentity {
  readonly channel: CommunicationChannel;
  readonly recipientKey: string;
  readonly idempotencyKey: string;
}

/**
 * Resolves the stable identifiers required before preflight, routing or
 * persistence. It does not evaluate consent or suppression policy.
 */
export function resolveCommunicationIntentIdentity(
  intent: CommunicationIntent,
): ResolvedCommunicationIntentIdentity {
  if (!nonBlank(intent.triggerKey)) {
    throw new CommunicationIntentIdentityError('TRIGGER_REQUIRED', 'triggerKey is required.');
  }
  if (!nonBlank(intent.tenantId)) {
    throw new CommunicationIntentIdentityError('TENANT_REQUIRED', 'tenantId is required.');
  }
  if (!nonBlank(intent.idempotencyKey)) {
    throw new CommunicationIntentIdentityError('IDEMPOTENCY_REQUIRED', 'idempotencyKey is required.');
  }

  const channel = intent.channel ?? inferDefaultCommunicationChannel(intent.recipient);
  if (channel === null) {
    throw new CommunicationIntentIdentityError('RECIPIENT_REQUIRED', 'Recipient has no routable address.');
  }
  if (!recipientSupportsChannel(intent.recipient, channel)) {
    throw new CommunicationIntentIdentityError(
      'CHANNEL_RECIPIENT_MISMATCH',
      `Recipient is not addressable through ${channel}.`,
    );
  }

  return {
    channel,
    recipientKey: communicationRecipientKey(intent.recipient, channel),
    idempotencyKey: intent.idempotencyKey.trim(),
  };
}

/**
 * Preserves BEMP's email -> WhatsApp -> SMS default precedence. Shared phone
 * addressing never implicitly selects voice or RCS, and subject identity never
 * implicitly selects push; those channels require explicit routing policy.
 */
export function inferDefaultCommunicationChannel(
  recipient: CommunicationRecipient,
): CommunicationChannel | null {
  if (nonBlank(recipient.email)) return 'email';
  if (nonBlank(recipient.whatsapp)) return 'whatsapp';
  if (nonBlank(recipient.phone)) return 'sms';
  if (nonBlank(recipient.subjectId)) return 'in_app';
  return null;
}

export function communicationRecipientKey(
  recipient: CommunicationRecipient,
  channel: CommunicationChannel,
): string {
  if (!recipientSupportsChannel(recipient, channel)) {
    throw new CommunicationIntentIdentityError(
      'CHANNEL_RECIPIENT_MISMATCH',
      `Recipient is not addressable through ${channel}.`,
    );
  }

  switch (communicationChannelMetadata(channel).addressKind) {
    case 'email':
      return recipient.email!.trim().toLowerCase();
    case 'phone':
      return recipient.phone!.trim();
    case 'whatsapp':
      return (recipient.whatsapp ?? recipient.phone)!.trim();
    case 'subject':
      return recipient.subjectId!.trim();
    case 'push':
      return (recipient.pushEndpoint ?? recipient.subjectId)!.trim();
  }
}

export function recipientSupportsChannel(
  recipient: CommunicationRecipient,
  channel: CommunicationChannel,
): boolean {
  switch (communicationChannelMetadata(channel).addressKind) {
    case 'email':
      return nonBlank(recipient.email);
    case 'phone':
      return nonBlank(recipient.phone);
    case 'whatsapp':
      return nonBlank(recipient.whatsapp ?? recipient.phone);
    case 'subject':
      return nonBlank(recipient.subjectId);
    case 'push':
      return nonBlank(recipient.pushEndpoint) || nonBlank(recipient.subjectId);
  }
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
export * from './webhook-ingestion.ts';
export * from './resend-webhook-normalizer.ts';
export * from './twilio-webhook-normalizer.ts';
export * from './queue-worker.ts';
