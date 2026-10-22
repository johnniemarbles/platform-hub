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

test('tenant-owned connector is visible to every entity node in that tenant (provider credential inheritance)', () => {
  // EXPADIO's org hierarchy (Brand HQ, Country OpCo, State Master, Unit) is
  // modeled as entity_nodes *within one tenant*, not as separate tenants.
  // routeConnector() has no node-scoping concept at all — it filters by
  // tenantId only — so a connector configured once at the tenant level is
  // already inherited by every node in that tenant's hierarchy without any
  // additional resolution step. This pins that property down: the request
  // shape below is identical to what a Country OpCo node, a State Master
  // node, and a Unit node would each construct for the same tenant, and all
  // three resolve to the one tenant-owned connector.
  const connectors = [connector({ connectorKey: 'brand-hq-email', ownership: 'TENANT', tenantId: 'tenant-brand' })];

  const asCountryOpco = routeConnector({ tenantId: 'tenant-brand', capabilityKey: 'email.delivery' }, connectors);
  const asStateMaster = routeConnector({ tenantId: 'tenant-brand', capabilityKey: 'email.delivery' }, connectors);
  const asUnit = routeConnector({ tenantId: 'tenant-brand', capabilityKey: 'email.delivery' }, connectors);

  for (const result of [asCountryOpco, asStateMaster, asUnit]) {
    assert.equal(result.connector?.connectorKey, 'brand-hq-email');
    assert.equal(result.reason, 'ROUTED');
  }
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
