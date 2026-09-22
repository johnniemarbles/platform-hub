import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyConversationHandoff,
  conversationContextKey,
  type ConversationSnapshot,
} from '../src/index.ts';

const baseConversation: ConversationSnapshot = {
  conversationId: 'conversation-1',
  tenantId: 'tenant-a',
  organizationId: 'org-a',
  subjectId: 'subject-1',
  channel: 'whatsapp',
  status: 'OPEN',
  ownership: { ownerType: 'HUMAN', ownerId: 'user-1' },
  context: [{ kind: 'lead', id: 'lead-1' }],
};

test('conversation context keys are generic, trimmed and stable', () => {
  assert.equal(conversationContextKey({ kind: ' lead ', id: ' abc ' }), 'lead:abc');
});

test('conversation context rejects blank kind or id', () => {
  assert.throws(() => conversationContextKey({ kind: ' ', id: 'abc' }));
  assert.throws(() => conversationContextKey({ kind: 'case', id: ' ' }));
});

test('handoff changes ownership while preserving the conversation boundary and context', () => {
  const next = applyConversationHandoff(baseConversation, {
    tenantId: 'tenant-a',
    conversationId: 'conversation-1',
    ownership: { ownerType: 'AI', ownerId: 'agent-1' },
  });

  assert.deepEqual(next.ownership, { ownerType: 'AI', ownerId: 'agent-1' });
  assert.equal(next.tenantId, baseConversation.tenantId);
  assert.equal(next.conversationId, baseConversation.conversationId);
  assert.deepEqual(next.context, baseConversation.context);
});

test('handoff fails closed across tenant or conversation boundaries', () => {
  assert.throws(() => applyConversationHandoff(baseConversation, {
    tenantId: 'tenant-b',
    conversationId: 'conversation-1',
    ownership: { ownerType: 'AI' },
  }));

  assert.throws(() => applyConversationHandoff(baseConversation, {
    tenantId: 'tenant-a',
    conversationId: 'conversation-2',
    ownership: { ownerType: 'SYSTEM' },
  }));
});
