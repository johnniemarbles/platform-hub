import type { PreparedCommunicationDispatch } from './dispatch.ts';
import type {
  CommunicationDeliveryState,
  CommunicationDeliveryTransition,
} from './delivery-state.ts';
import type { CommunicationChannel } from './index.ts';

export interface CommunicationDeliveryDispatchSnapshot {
  readonly dispatch: PreparedCommunicationDispatch;
  readonly consentRequired: boolean;
}

export interface CommunicationDeliveryRecord {
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly idempotencyKey: string;
  readonly channel: CommunicationChannel;
  readonly connectorKey: string;
  readonly adapterKey: string;
  readonly providerMessageId?: string;
  readonly state: CommunicationDeliveryState;
  readonly attemptCount: number;
  readonly lastReasonCode?: string;
  readonly lastReason?: string;
  readonly requestedAt: string;
  readonly acceptedAt?: string;
  readonly updatedAt: string;
  readonly dispatchSnapshot?: CommunicationDeliveryDispatchSnapshot;
  readonly nextAttemptAt?: string;
  readonly lastAttemptAt?: string;
  readonly claimToken?: string;
  readonly claimExpiresAt?: string;
}

export interface CreateCommunicationDeliveryInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly idempotencyKey: string;
  readonly channel: CommunicationChannel;
  readonly connectorKey: string;
  readonly adapterKey: string;
  readonly requestedAt: string;
  /**
   * Required for autonomous provider-worker execution. Legacy synchronous send
   * helpers may omit it; such rows remain non-worker-eligible.
   */
  readonly dispatchSnapshot?: CommunicationDeliveryDispatchSnapshot;
}

export interface RecordCommunicationDeliveryAttemptInput {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
  readonly reason?: string;
  readonly attemptToken?: string;
}

export interface ApplyCommunicationDeliveryTransitionInput {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly transition: CommunicationDeliveryTransition;
  readonly providerMessageId?: string;
  readonly incrementAttempt?: boolean;
  readonly attemptToken?: string;
}

export interface ApplyCommunicationDeliveryTransitionResult {
  readonly applied: boolean;
  readonly delivery: CommunicationDeliveryRecord;
}

export interface CommunicationDeliveryRepository {
  createOrGet(input: CreateCommunicationDeliveryInput): Promise<CommunicationDeliveryRecord>;
  findByIdempotencyKey(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
  }): Promise<CommunicationDeliveryRecord | null>;
  findByProviderMessageId(input: {
    readonly tenantId: string;
    readonly connectorKey: string;
    readonly providerMessageId: string;
  }): Promise<CommunicationDeliveryRecord | null>;
  recordAttempt(input: RecordCommunicationDeliveryAttemptInput): Promise<CommunicationDeliveryRecord>;
  applyTransition(
    input: ApplyCommunicationDeliveryTransitionInput,
  ): Promise<ApplyCommunicationDeliveryTransitionResult>;
}
