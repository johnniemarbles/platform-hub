import type {
  CommunicationChannel,
  CommunicationSuppression,
  CommunicationSuppressionReason,
} from './index.ts';

export interface PersistedCommunicationSuppression extends CommunicationSuppression {
  readonly suppressionId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly sourceMessageId?: string;
  readonly recordedAt: string;
  readonly validUntil?: string;
}

export interface FindActiveSuppressionInput {
  readonly tenantId: string;
  /** When provided, organization-specific suppression takes precedence over tenant-wide suppression. */
  readonly organizationId?: string;
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly at?: string;
}

export interface AddSuppressionInput {
  readonly tenantId: string;
  /** Omit for tenant-wide suppression. */
  readonly organizationId?: string;
  /** Stable recipient key produced by `resolveCommunicationIntentIdentity`. */
  readonly recipientKey: string;
  readonly channel: CommunicationChannel;
  readonly reason: CommunicationSuppressionReason;
  readonly sourceMessageId?: string;
  readonly recordedAt?: string;
  readonly validUntil?: string;
}

export interface RevokeSuppressionInput {
  readonly tenantId: string;
  readonly suppressionId: string;
  readonly revokedAt?: string;
}

/**
 * Domain persistence port for tenant and organization suppressions.
 * Platform-global suppression is deliberately outside this tenant-readable port.
 */
export interface CommunicationSuppressionRepository {
  findActive(input: FindActiveSuppressionInput): Promise<PersistedCommunicationSuppression | null>;
  add(input: AddSuppressionInput): Promise<PersistedCommunicationSuppression>;
  revoke(input: RevokeSuppressionInput): Promise<boolean>;
}
