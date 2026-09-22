import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StaticCommunicationProviderAdapterRegistry,
} from '../src/provider-adapter-registry.ts';
import type {
  CommunicationProviderAdapter,
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from '../src/provider-adapter.ts';

const emailAdapter: CommunicationProviderAdapter = {
  adapterKey: 'email-adapter',
  supportedChannels: ['email'],
  async send(_request: CommunicationProviderSendRequest): Promise<CommunicationProviderSendResult> {
    return { status: 'ACCEPTED', reasonCode: 'OK' };
  },
};

test('resolves provider keys case-insensitively for supported channels', () => {
  const registry = new StaticCommunicationProviderAdapterRegistry([
    { providerKey: '  Resend  ', adapter: emailAdapter },
  ]);
  assert.equal(registry.resolve({ providerKey: 'resend', channel: 'email' }), emailAdapter);
});

test('returns null for an unsupported channel or unknown provider', () => {
  const registry = new StaticCommunicationProviderAdapterRegistry([
    { providerKey: 'resend', adapter: emailAdapter },
  ]);
  assert.equal(registry.resolve({ providerKey: 'resend', channel: 'sms' }), null);
  assert.equal(registry.resolve({ providerKey: 'twilio', channel: 'sms' }), null);
});

test('rejects duplicate normalized provider keys', () => {
  assert.throws(
    () => new StaticCommunicationProviderAdapterRegistry([
      { providerKey: 'resend', adapter: emailAdapter },
      { providerKey: ' RESEND ', adapter: emailAdapter },
    ]),
    /COMMUNICATION_PROVIDER_ADAPTER_DUPLICATE:resend/,
  );
});

test('rejects blank provider keys', () => {
  assert.throws(
    () => new StaticCommunicationProviderAdapterRegistry([
      { providerKey: '   ', adapter: emailAdapter },
    ]),
    /COMMUNICATION_PROVIDER_KEY_REQUIRED/,
  );
});
