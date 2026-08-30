import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoleAssignment } from '@expadio/authorization';
import type {
  AuthorizationPolicy,
  AuthorizationPolicyRepository,
} from '@expadio/authorization-persistence';
import type { EffectiveContext } from '@expadio/tenancy';
import {
  credentialReference,
  type CredentialLeaseAuthorizationQuery,
} from '../src/index.ts';
import {
  PersistedCredentialLeaseAuthorizer,
  type CredentialLeaseEffectiveContextProvider,
} from '../src/persisted-credential-lease-authorizer.ts';

const context: EffectiveContext = {
  subjectId: 'subject-1',
  actorKind: 'user',
  tenantId: 'tenant-1',
  organizationId: 'org-1',
};

const query: CredentialLeaseAuthorizationQuery = {
  requestId: 'request-1',
  tenantId: 'tenant-1',
  requestedBySubjectId: 'subject-1',
  connectorKey: 'resend-primary',
  purpose: 'communication.email.send:system',
  requestedAt: '2026-08-30T05:00:00.000Z',
  correlationId: 'correlation-1',
  evidenceRefs: ['communication://test-send/1'],
  action: 'credential.lease',
  credentialReference: credentialReference(
    'vault://tenant/11111111-1111-1111-1111-111111111111/connector/resend-primary/v3',
  ),
};

class StaticContextProvider implements CredentialLeaseEffectiveContextProvider {
  readonly value: EffectiveContext;

  constructor(value: EffectiveContext) {
    this.value = value;
  }

  async resolve(): Promise<EffectiveContext> {
    return this.value;
  }
}

class StaticPolicyRepository implements AuthorizationPolicyRepository {
  readonly calls: EffectiveContext[] = [];
  readonly policy: AuthorizationPolicy;

  constructor(policy: AuthorizationPolicy) {
    this.policy = policy;
  }

  async loadPolicy(value: EffectiveContext): Promise<AuthorizationPolicy> {
    this.calls.push(value);
    return this.policy;
  }
}

function assignment(
  overrides: Partial<RoleAssignment> = {},
): RoleAssignment {
  return {
    roleKey: 'communications-operator',
    capabilities: [
      { action: 'credential.lease', resourceType: 'connector-credential' },
    ],
    actionScope: {
      tenantId: 'tenant-1',
      organizationIds: ['org-1'],
    },
    clearances: ['sensitive'],
    sensitiveCompartments: ['provider-credentials'],
    ...overrides,
  };
}

test('authorizes a credential lease through persisted role policy', async () => {
  const repository = new StaticPolicyRepository({
    assignments: [assignment()],
    restrictions: [],
  });
  const authorizer = new PersistedCredentialLeaseAuthorizer({
    contextProvider: new StaticContextProvider(context),
    policyRepository: repository,
    decisionId: () => 'decision-1',
  });

  const decision = await authorizer.authorize(query);

  assert.deepEqual(decision, {
    decisionId: 'decision-1',
    allowed: true,
    reasonKey: 'GRANTED',
  });
  assert.deepEqual(repository.calls, [context]);
});

test('fails closed when the persisted role does not grant credential leasing', async () => {
  const repository = new StaticPolicyRepository({
    assignments: [
      assignment({
        capabilities: [{ action: 'read', resourceType: 'connector-credential' }],
      }),
    ],
    restrictions: [],
  });
  const authorizer = new PersistedCredentialLeaseAuthorizer({
    contextProvider: new StaticContextProvider(context),
    policyRepository: repository,
    decisionId: () => 'decision-2',
  });

  const decision = await authorizer.authorize(query);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonKey, 'CAPABILITY_NOT_GRANTED');
});

test('requires sensitive provider-credential clearance', async () => {
  const repository = new StaticPolicyRepository({
    assignments: [assignment({ sensitiveCompartments: [] })],
    restrictions: [],
  });
  const authorizer = new PersistedCredentialLeaseAuthorizer({
    contextProvider: new StaticContextProvider(context),
    policyRepository: repository,
    decisionId: () => 'decision-3',
  });

  const decision = await authorizer.authorize(query);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonKey, 'CLASSIFICATION_NOT_CLEARED');
});

test('rejects a context that does not match the requested subject or tenant', async () => {
  const repository = new StaticPolicyRepository({
    assignments: [assignment()],
    restrictions: [],
  });
  const authorizer = new PersistedCredentialLeaseAuthorizer({
    contextProvider: new StaticContextProvider({
      ...context,
      subjectId: 'other-subject',
    }),
    policyRepository: repository,
    decisionId: () => 'decision-4',
  });

  const decision = await authorizer.authorize(query);
  assert.deepEqual(decision, {
    decisionId: 'decision-4',
    allowed: false,
    reasonKey: 'CREDENTIAL_CONTEXT_MISMATCH',
  });
  assert.equal(repository.calls.length, 0);
});
