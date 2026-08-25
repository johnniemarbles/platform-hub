import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedCommunicationDispatch } from '../src/dispatch.ts';
import { prepareCommunicationProviderSendRequest } from '../src/provider-send-request.ts';
import type {
  CommunicationSenderRepository,
  CommunicationSenderResolutionInput,
} from '../src/sender.ts';

const dispatch: PreparedCommunicationDispatch = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  triggerKey: 'lead.followup',
  purpose: 'marketing',
  channel: 'email',
  recipient: { email: 'person@example.com' },
  recipientKey: 'person@example.com',
  idempotencyKey: 'followup-1',
  templateScope: 'TENANT',
  rendered: {
    templateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    version: 1,
    channel: 'email',
    locale: 'en',
    format: 'TEXT',
    subject: 'Hello',
    body: 'Hello person',
    variables: {},
  },
  compliance: {
    preflight: { allowed: true, reasonCode: 'OK', reason: 'Communication preflight passed.' },
    evaluatedAt: '2026-08-25T00:00:00.000Z',
  },
  routing: { capabilityKey: 'communication.email.send' },
  requestedAt: '2026-08-25T00:00:00.000Z',
};

function senderRepository() {
  const calls: CommunicationSenderResolutionInput[] = [];
  const repository: CommunicationSenderRepository = {
    async resolveVerifiedDefault(input) {
      calls.push(input);
      return {
        matchedScope: 'TENANT',
        sender: {
          senderId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          scope: { kind: 'TENANT', tenantId: dispatch.tenantId },
          channel: 'email',
          address: 'hello@tenant.test',
          displayName: 'Tenant',
          replyTo: 'reply@tenant.test',
          purposes: ['marketing', 'transactional'],
          isDefault: true,
          isSystemFallback: false,
          verificationStatus: 'VERIFIED',
          status: 'ACTIVE',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      };
    },
  };
  return { repository, calls };
}

test('resolves sender and prepares provider request for external sender channels', async () => {
  const { repository, calls } = senderRepository();

  const result = await prepareCommunicationProviderSendRequest({
    dispatch,
    senderRepository: repository,
    platformFallback: 'DENY',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.senderScope, 'TENANT');
  assert.deepEqual(calls, [{
    tenantId: dispatch.tenantId,
    organizationId: dispatch.organizationId,
    channel: 'email',
    purpose: 'marketing',
    platformFallback: 'DENY',
  }]);
  assert.deepEqual(result.request.sender, {
    senderKey: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    address: 'hello@tenant.test',
    displayName: 'Tenant',
    replyTo: 'reply@tenant.test',
  });
  assert.equal(result.request.recipientKey, 'person@example.com');
  assert.equal(result.request.rendered.templateId, dispatch.rendered.templateId);
});

test('fails closed with SENDER_UNVERIFIED when no verified default sender resolves', async () => {
  const repository: CommunicationSenderRepository = {
    async resolveVerifiedDefault() {
      return { matchedScope: 'NONE', sender: null };
    },
  };

  const result = await prepareCommunicationProviderSendRequest({
    dispatch,
    senderRepository: repository,
    platformFallback: 'ALLOW',
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'SENDER_UNVERIFIED',
    senderScope: 'NONE',
  });
});

test('in-app delivery skips sender resolution and omits sender', async () => {
  let called = false;
  const repository: CommunicationSenderRepository = {
    async resolveVerifiedDefault() {
      called = true;
      throw new Error('sender lookup should not run');
    },
  };

  const inAppDispatch: PreparedCommunicationDispatch = {
    ...dispatch,
    channel: 'in_app',
    recipient: { subjectId: 'user-1' },
    recipientKey: 'user-1',
    rendered: { ...dispatch.rendered, channel: 'in_app' },
    routing: { capabilityKey: 'communication.in_app.send' },
  };

  const result = await prepareCommunicationProviderSendRequest({
    dispatch: inAppDispatch,
    senderRepository: repository,
    platformFallback: 'DENY',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(called, false);
  assert.equal(result.senderScope, 'NONE');
  assert.equal(result.request.sender, undefined);
});

test('sender repository failures propagate instead of producing a sendable request', async () => {
  const repository: CommunicationSenderRepository = {
    async resolveVerifiedDefault() {
      throw new Error('sender store unavailable');
    },
  };

  await assert.rejects(
    prepareCommunicationProviderSendRequest({
      dispatch,
      senderRepository: repository,
      platformFallback: 'ALLOW',
    }),
    /sender store unavailable/,
  );
});
