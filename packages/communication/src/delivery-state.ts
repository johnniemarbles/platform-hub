export type CommunicationDeliveryState =
  | 'PENDING'
  | 'ACCEPTED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'CANCELLED';

export type CommunicationDeliveryTerminalState = Extract<
  CommunicationDeliveryState,
  'DELIVERED' | 'FAILED' | 'BOUNCED' | 'COMPLAINED' | 'CANCELLED'
>;

export interface CommunicationDeliveryAttemptIdentity {
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly connectorKey: string;
  readonly adapterKey: string;
  readonly providerMessageId?: string;
}

export interface CommunicationDeliveryTransition {
  readonly from: CommunicationDeliveryState;
  readonly to: CommunicationDeliveryState;
  readonly occurredAt: string;
  readonly providerEventId?: string;
  readonly reasonCode?: string;
  readonly reason?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<CommunicationDeliveryState, readonly CommunicationDeliveryState[]>> = {
  PENDING: ['ACCEPTED', 'FAILED', 'CANCELLED'],
  ACCEPTED: ['SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'CANCELLED'],
  SENT: ['DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED'],
  DELIVERED: ['COMPLAINED'],
  FAILED: [],
  BOUNCED: [],
  COMPLAINED: [],
  CANCELLED: [],
};

export function canApplyDeliveryTransition(
  from: CommunicationDeliveryState,
  to: CommunicationDeliveryState,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertDeliveryTransition(
  from: CommunicationDeliveryState,
  to: CommunicationDeliveryState,
): void {
  if (!canApplyDeliveryTransition(from, to)) {
    throw new Error(`COMMUNICATION_DELIVERY_TRANSITION_INVALID:${from}->${to}`);
  }
}
