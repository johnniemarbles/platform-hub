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
