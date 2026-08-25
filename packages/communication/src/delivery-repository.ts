import type {
  CommunicationDeliveryState,
  CommunicationDeliveryTransition,
} from './delivery-state.ts';
import type { CommunicationChannel } from './index.ts';

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
}

export interface CreateCommunicationDeliveryInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly idempotencyKey: string;
  readonly channel: CommunicationChannel;
  readonly connectorKey: string;
  readonly adapterKey: string;
  readonly requestedAt: string;
}

export interface RecordCommunicationDeliveryAttemptInput {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
  readonly reason?: string;
}

export interface ApplyCommunicationDeliveryTransitionInput {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly transition: CommunicationDeliveryTransition;
  readonly providerMessageId?: string;
  readonly incrementAttempt?: boolean;
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
