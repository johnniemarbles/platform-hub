import type { CommunicationChannel, CommunicationPurpose } from './index.ts';

export type CommunicationConsentEventType = 'GRANTED' | 'WITHDRAWN';
export type CommunicationConsentSource = 'FORM' | 'API' | 'IMPORT' | 'ADMIN' | 'SYSTEM' | 'OTHER';
export type CommunicationConsentScope = 'ORGANIZATION' | 'TENANT' | 'NONE';

export interface PersistedCommunicationConsentEvent {
  readonly consentEventId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly subjectId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly purpose: CommunicationPurpose;
  readonly eventType: CommunicationConsentEventType;
  readonly source: CommunicationConsentSource;
  readonly policyVersion?: string;
  readonly evidenceRef?: string;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly recordedAt: string;
}

export interface RecordCommunicationConsentEventInput {
  readonly tenantId: string;
  /** Omit for tenant-wide consent scope. */
  readonly organizationId?: string;
  readonly subjectId?: string;
  /** Stable recipient key produced by `resolveCommunicationIntentIdentity`. */
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly purpose: CommunicationPurpose;
  readonly eventType: CommunicationConsentEventType;
  readonly source: CommunicationConsentSource;
  readonly policyVersion?: string;
  readonly evidenceRef?: string;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
}

export interface ResolveEffectiveCommunicationConsentInput {
  readonly tenantId: string;
  /** When supplied, an applicable organization event takes precedence over tenant-wide consent. */
  readonly organizationId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly purpose: CommunicationPurpose;
  readonly at?: string;
}

export interface EffectiveCommunicationConsent {
  readonly granted: boolean;
  readonly scope: CommunicationConsentScope;
  readonly event: PersistedCommunicationConsentEvent | null;
}

/**
 * Append-only consent persistence port. Resolution must fail closed: no
 * applicable event or a WITHDRAWN event means consent is not granted.
 */
export interface CommunicationConsentRepository {
  record(
    input: RecordCommunicationConsentEventInput,
  ): Promise<PersistedCommunicationConsentEvent>;
  resolveEffective(
    input: ResolveEffectiveCommunicationConsentInput,
  ): Promise<EffectiveCommunicationConsent>;
}
