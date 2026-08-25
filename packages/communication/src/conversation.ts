import type { CommunicationChannel } from './index.ts';

export type ConversationOwnerType = 'HUMAN' | 'AI' | 'SYSTEM';
export type ConversationStatus = 'OPEN' | 'CLOSED';
export type ConversationDirection = 'INBOUND' | 'OUTBOUND';
export type ConversationSenderType = 'PERSON' | 'HUMAN' | 'AI' | 'SYSTEM';

export interface ConversationOwnership {
  readonly ownerType: ConversationOwnerType;
  readonly ownerId?: string;
}

export interface ConversationContextRef {
  readonly kind: string;
  readonly id: string;
}

export interface CreateConversationInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly subjectId?: string;
  readonly channel?: CommunicationChannel;
  readonly ownership?: ConversationOwnership;
  readonly context?: readonly ConversationContextRef[];
}

export interface AppendConversationMessageInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly channel: CommunicationChannel;
  readonly direction: ConversationDirection;
  readonly senderType: ConversationSenderType;
  readonly senderId?: string;
  readonly communicationMessageId?: string;
  readonly providerMessageId?: string;
  readonly body?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
}

export interface ConversationHandoffInput {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ownership: ConversationOwnership;
}

export interface ConversationSnapshot {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly subjectId?: string;
  readonly channel?: CommunicationChannel;
  readonly status: ConversationStatus;
  readonly ownership: ConversationOwnership;
  readonly context: readonly ConversationContextRef[];
}

/**
 * Creates a stable generic context key without introducing lead/case/vertical
 * vocabulary into the communication core.
 */
export function conversationContextKey(reference: ConversationContextRef): string {
  const kind = reference.kind.trim();
  const id = reference.id.trim();
  if (kind.length === 0 || id.length === 0) {
    throw new Error('Conversation context requires non-empty kind and id.');
  }
  return `${kind}:${id}`;
}

export function applyConversationHandoff(
  conversation: ConversationSnapshot,
  handoff: ConversationHandoffInput,
): ConversationSnapshot {
  if (handoff.tenantId !== conversation.tenantId || handoff.conversationId !== conversation.conversationId) {
    throw new Error('Conversation handoff does not match the target conversation boundary.');
  }
  return {
    ...conversation,
    ownership: handoff.ownership,
  };
}
