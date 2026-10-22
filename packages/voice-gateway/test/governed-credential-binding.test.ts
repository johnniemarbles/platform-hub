import assert from 'node:assert/strict';
import test from 'node:test';
import { governedVoiceApiTokenProvider } from '../src/governed-credential-binding.ts';

test('governedVoiceApiTokenProvider leases and resolves a voice secret', async () => {
  const provider = governedVoiceApiTokenProvider({
    connectors: [{
      connectorKey: 'voice-stt-1',
      providerType: 'deepgram',
      providerKey: 'deepgram',
      ownership: 'TENANT',
      tenantId: 't1',
      capabilityKeys: ['voice.transcribe'],
      residencyTags: [],
      complianceTags: [],
      health: 'HEALTHY',
      priority: 1,
      enabled: true,
      fallbackEnabled: false,
    }],
    credentialRepository: {
      async loadCredentialReference() { return 'vault://tenant/t1/connector/voice-stt-1/v1' as never; },
    } as never,
    leaseService: {
      async issue() {
        return {
          leaseId: 'lease-1',
          credentialReference: 'vault://tenant/t1/connector/voice-stt-1/v1',
          issuedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T00:05:00.000Z',
        };
      },
    },
    secretResolver: {
      async resolve() { return { value: 'dg-token' }; },
    },
    requestedBySubjectId: 'subject-1',
    requestId: () => 'req-1',
    correlationId: () => 'corr-1',
    now: () => '2026-01-01T00:00:01.000Z',
  });
  const token = await provider({
    tenantId: 't1',
    connectorKey: 'voice-stt-1',
    operation: 'TRANSCRIBE',
    purpose: 'test',
    idempotencyKey: 'idemp-1',
    requestedAt: '2026-01-01T00:00:01.000Z',
  });
  assert.equal(token, 'dg-token');
});
