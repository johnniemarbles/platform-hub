import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeCommunicationProvider } from '../src/provider-invocation.ts';
import type { CommunicationProviderAdapter } from '../src/provider-adapter.ts';
import { StaticCommunicationProviderAdapterRegistry } from '../src/provider-adapter-registry.ts';

const request = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  triggerKey: 'lead.welcome',
  purpose: 'transactional' as const,
  channel: 'email' as const,
  recipient: { email: 'person@example.test' },
  recipientKey: 'email:person@example.test',
  rendered: {
    templateId: '11111111-1111-1111-1111-111111111111',
    templateVersion: 1,
    matchedScope: 'TENANT' as const,
    format: 'TEXT' as const,
    body: 'Hello',
  },
  idempotencyKey: 'idem-1',
  requestedAt: '2026-08-25T05:00:00.000Z',
};

const connector = {
  connectorKey: 'email-primary',
  providerType: 'email',
  providerKey: 'resend',
  ownership: 'PLATFORM' as const,
};

test('invokes the adapter selected by provider key and channel', async () => {
  const seen: unknown[] = [];
  const adapter: CommunicationProviderAdapter = {
    adapterKey: 'resend-runtime',
    supportedChannels: ['email'],
    async send(value) {
      seen.push(value);
      return { status: 'ACCEPTED', reasonCode: 'OK', providerMessageId: 'msg-1' };
    },
  };
  const result = await invokeCommunicationProvider({
    connector,
    request,
    registry: new StaticCommunicationProviderAdapterRegistry([
      { providerKey: 'resend', adapter },
    ]),
  });
  assert.equal(result.invoked, true);
  if (!result.invoked) return;
  assert.equal(result.adapterKey, 'resend-runtime');
  assert.equal(result.connectorKey, 'email-primary');
  assert.equal(result.result.providerMessageId, 'msg-1');
  assert.deepEqual(seen, [request]);
});

test('fails closed when no adapter is registered for the routed provider', async () => {
  const result = await invokeCommunicationProvider({
    connector,
    request,
    registry: new StaticCommunicationProviderAdapterRegistry([]),
  });
  assert.deepEqual(result, {
    invoked: false,
    reasonCode: 'PROVIDER_ADAPTER_UNAVAILABLE',
    connectorKey: 'email-primary',
    providerKey: 'resend',
  });
});

test('provider exceptions propagate for the retry/delivery layer to classify', async () => {
  const adapter: CommunicationProviderAdapter = {
    adapterKey: 'resend-runtime',
    supportedChannels: ['email'],
    async send() {
      throw new Error('network down');
    },
  };
  await assert.rejects(
    () => invokeCommunicationProvider({
      connector,
      request,
      registry: new StaticCommunicationProviderAdapterRegistry([
        { providerKey: 'resend', adapter },
      ]),
    }),
    /network down/,
  );
});
