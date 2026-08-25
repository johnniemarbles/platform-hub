import type { CommunicationChannel, CommunicationPurpose } from './index.ts';

export type CommunicationSenderChannel = Extract<
  CommunicationChannel,
  'email' | 'sms' | 'whatsapp' | 'voice' | 'rcs'
>;

export type CommunicationSenderScope =
  | { readonly kind: 'PLATFORM' }
  | { readonly kind: 'TENANT'; readonly tenantId: string }
  | {
      readonly kind: 'ORGANIZATION';
      readonly tenantId: string;
      readonly organizationId: string;
    };

export type CommunicationSenderVerificationStatus =
  | 'PENDING'
  | 'VERIFIED'
  | 'FAILED'
  | 'REVOKED';

export type CommunicationSenderStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export interface CommunicationSenderIdentity {
  readonly senderId: string;
  readonly scope: CommunicationSenderScope;
  readonly channel: CommunicationSenderChannel;
  readonly address: string;
  readonly displayName?: string;
  readonly replyTo?: string;
  readonly purposes: readonly CommunicationPurpose[];
  readonly isDefault: boolean;
  readonly isSystemFallback: boolean;
  readonly verificationStatus: CommunicationSenderVerificationStatus;
  readonly status: CommunicationSenderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CommunicationSenderPlatformFallback = 'ALLOW' | 'DENY';

export interface CommunicationSenderResolutionInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly channel: CommunicationSenderChannel;
  readonly purpose: CommunicationPurpose;
  readonly platformFallback: CommunicationSenderPlatformFallback;
}

export type CommunicationSenderMatchedScope =
  | 'ORGANIZATION'
  | 'TENANT'
  | 'PLATFORM'
  | 'NONE';

export interface CommunicationSenderResolution {
  readonly matchedScope: CommunicationSenderMatchedScope;
  readonly sender: CommunicationSenderIdentity | null;
}

/**
 * Runtime read boundary for outbound sender selection. Implementations resolve
 * only ACTIVE + VERIFIED identities supporting the requested channel/purpose,
 * preferring ORGANIZATION -> TENANT -> PLATFORM when platform fallback is
 * explicitly allowed. Verification mechanics remain outside this contract.
 */
export interface CommunicationSenderRepository {
  resolveVerifiedDefault(
    input: CommunicationSenderResolutionInput,
  ): Promise<CommunicationSenderResolution>;
}
