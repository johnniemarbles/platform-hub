import type { CommunicationChannel, CommunicationPurpose } from './index.ts';

export interface CommunicationConsentQuery {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly purpose: CommunicationPurpose;
  readonly at?: string;
}

export interface CommunicationConsentResolution {
  readonly granted: boolean;
}

export interface CommunicationConsentRepository {
  resolveEffective(query: CommunicationConsentQuery): Promise<CommunicationConsentResolution | null>;
}

export interface CommunicationSuppressionQuery {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly at?: string;
}

export interface CommunicationSuppressionResolution {
  readonly reason: 'BOUNCE' | 'COMPLAINT' | 'OPT_OUT' | 'LEGAL_HOLD' | 'UNSUBSCRIBE';
}

export interface CommunicationSuppressionRepository {
  findActive(query: CommunicationSuppressionQuery): Promise<CommunicationSuppressionResolution | null>;
}
