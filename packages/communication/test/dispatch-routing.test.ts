import assert from 'node:assert/strict';
import test from 'node:test';
import {
  credentialReference,
  type ConnectorDefinition,
  type RoutingPolicy,
} from '@platform-hub/provider-registry';
import type { PreparedCommunicationDispatch } from '../src/dispatch.ts';
import { routePreparedCommunicationDispatch } from '../src/dispatch-routing.ts';

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

function connector(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    connectorKey: 'platform-email',
    providerType: 'email',
    providerKey: 'provider-a',
    ownership: 'PLATFORM',
    capabilityKeys: ['communication.email.send'],
    credentialRef: credentialReference('secret://communication/platform-email'),
    region: 'ca-central-1',
    residencyTags: ['CA'],
    complianceTags: ['SOC2'],
    health: 'HEALTHY',
    priority: 10,
    enabled: true,
    fallbackEnabled: true,
    ...overrides,
  };
}

test('routes through Provider Registry and returns metadata without credentialRef', () => {
  const result = routePreparedCommunicationDispatch(dispatch, [connector()]);

  assert.equal(result.routed, true);
  if (!result.routed) return;
  assert.deepEqual(result.connector, {
    connectorKey: 'platform-email',
    providerType: 'email',
    providerKey: 'provider-a',
    ownership: 'PLATFORM',
    region: 'ca-central-1',
  });
  assert.equal('credentialRef' in result.connector, false);
});

test('does not use platform connectors as tenant fallback until explicitly enabled', () => {
  const result = routePreparedCommunicationDispatch(
    dispatch,
    [connector({ connectorKey: 'platform-email-private', fallbackEnabled: false })],
  );

  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.reasonCode, 'NOT_CONFIGURED');
  assert.deepEqual(result.considered, []);
});

test('allows a tenant routing policy to bind one platform connector without broad fallback', () => {
  const policy: RoutingPolicy = {
    tenantId: dispatch.tenantId,
    capabilityKey: dispatch.routing.capabilityKey,
    allowedConnectorKeys: ['platform-email-private'],
  };
  const result = routePreparedCommunicationDispatch(
    dispatch,
    [connector({ connectorKey: 'platform-email-private', fallbackEnabled: false })],
    policy,
  );

  assert.equal(result.routed, true);
  if (!result.routed) return;
  assert.equal(result.connector.connectorKey, 'platform-email-private');
  assert.equal(result.connector.ownership, 'PLATFORM');
});

test('honors tenant-owned preference through the existing routing policy', () => {
  const tenantConnector = connector({
    connectorKey: 'tenant-email',
    providerKey: 'provider-b',
    ownership: 'TENANT',
    tenantId: dispatch.tenantId,
    priority: 50,
  });
  const policy: RoutingPolicy = {
    tenantId: dispatch.tenantId,
    capabilityKey: dispatch.routing.capabilityKey,
    preferTenantOwned: true,
  };

  const result = routePreparedCommunicationDispatch(
    dispatch,
    [connector({ priority: 1 }), tenantConnector],
    policy,
  );

  assert.equal(result.routed, true);
  if (!result.routed) return;
  assert.equal(result.connector.connectorKey, 'tenant-email');
  assert.equal(result.connector.ownership, 'TENANT');
});

test('returns NOT_CONFIGURED when no connector provides the capability', () => {
  const result = routePreparedCommunicationDispatch(dispatch, []);

  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.reasonCode, 'NOT_CONFIGURED');
});

test('returns PROVIDER_UNAVAILABLE when matching connectors are disabled', () => {
  const result = routePreparedCommunicationDispatch(
    dispatch,
    [connector({ enabled: false })],
  );

  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.reasonCode, 'PROVIDER_UNAVAILABLE');
});

test('returns RESIDENCY_BLOCKED when region or residency requirements cannot be met', () => {
  const result = routePreparedCommunicationDispatch(
    {
      ...dispatch,
      routing: {
        capabilityKey: 'communication.email.send',
        requiredResidencyTags: ['EU'],
      },
    },
    [connector()],
  );

  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.reasonCode, 'RESIDENCY_BLOCKED');
});

test('returns GOVERNANCE_BLOCKED for non-residency compliance rejection', () => {
  const result = routePreparedCommunicationDispatch(
    {
      ...dispatch,
      routing: {
        capabilityKey: 'communication.email.send',
        requiredComplianceTags: ['HIPAA'],
      },
    },
    [connector()],
  );

  assert.equal(result.routed, false);
  if (result.routed) return;
  assert.equal(result.reasonCode, 'GOVERNANCE_BLOCKED');
});
