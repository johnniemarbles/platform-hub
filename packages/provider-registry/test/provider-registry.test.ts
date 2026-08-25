import assert from 'node:assert/strict';
import test from 'node:test';
import {
  credentialReference,
  routeConnector,
  type ConnectorDefinition,
} from '../src/index.ts';

function connector(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    connectorKey: 'platform-email-primary',
    providerType: 'email',
    providerKey: 'provider-a',
    ownership: 'PLATFORM',
    capabilityKeys: ['email.delivery'],
    credentialRef: credentialReference('vault://providers/email/primary'),
    region: 'ca-central',
    residencyTags: ['CA'],
    complianceTags: ['PIPEDA'],
    health: 'HEALTHY',
    priority: 10,
    enabled: true,
    fallbackEnabled: true,
    ...overrides,
  };
}

test('credential references reject raw-looking values and accept external secret references', () => {
  assert.throws(() => credentialReference('sk-live-raw-secret'));
  assert.equal(credentialReference('secret://tenant/acme/email'), 'secret://tenant/acme/email');
});

test('tenant-owned connector is invisible to another tenant', () => {
  const result = routeConnector(
    { tenantId: 'tenant-b', capabilityKey: 'email.delivery' },
    [connector({ connectorKey: 'tenant-a-email', ownership: 'TENANT', tenantId: 'tenant-a' })],
  );
  assert.equal(result.connector, null);
  assert.deepEqual(result.considered, []);
});

test('routing fails closed when residency or compliance requirements are not met', () => {
  const result = routeConnector(
    {
      tenantId: 'tenant-a',
      capabilityKey: 'email.delivery',
      requiredResidencyTags: ['CA'],
      requiredComplianceTags: ['SOC2'],
    },
    [connector()],
  );
  assert.equal(result.reason, 'NO_COMPLIANT_CONNECTOR');
  assert.deepEqual(result.rejected['platform-email-primary'], ['COMPLIANCE_MISMATCH']);
});

test('tenant-owned connector can be preferred without bypassing policy constraints', () => {
  const tenantConnector = connector({
    connectorKey: 'tenant-email',
    ownership: 'TENANT',
    tenantId: 'tenant-a',
    priority: 50,
  });
  const result = routeConnector(
    { tenantId: 'tenant-a', capabilityKey: 'email.delivery' },
    [connector(), tenantConnector],
    { tenantId: 'tenant-a', capabilityKey: 'email.delivery', preferTenantOwned: true },
  );
  assert.equal(result.connector?.connectorKey, 'tenant-email');
});

test('unhealthy connector is rejected and a compliant healthy connector may route', () => {
  const result = routeConnector(
    { tenantId: 'tenant-a', capabilityKey: 'email.delivery' },
    [
      connector({ connectorKey: 'primary', health: 'UNHEALTHY', priority: 1 }),
      connector({ connectorKey: 'secondary', health: 'HEALTHY', priority: 2 }),
    ],
  );
  assert.equal(result.connector?.connectorKey, 'secondary');
  assert.deepEqual(result.rejected.primary, ['UNHEALTHY']);
});

test('conflicting region requirements fail closed instead of widening routing', () => {
  const result = routeConnector(
    { tenantId: 'tenant-a', capabilityKey: 'email.delivery', requiredRegions: ['ca-central'] },
    [connector()],
    { tenantId: 'tenant-a', capabilityKey: 'email.delivery', requiredRegions: ['us-east'] },
  );
  assert.equal(result.connector, null);
  assert.ok(result.rejected['platform-email-primary']?.includes('REGION_POLICY_CONFLICT'));
});
