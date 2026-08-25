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
