import { authorize } from '@expadio/authorization';
import {
  buildAuthorizationInput,
  type AuthorizationPolicyRepository,
} from '@expadio/authorization-persistence';
import type { EffectiveContext } from '@expadio/tenancy';
import type {
  CredentialLeaseAuthorizationDecision,
  CredentialLeaseAuthorizationQuery,
  CredentialLeaseAuthorizer,
} from './credential-access.ts';

export interface CredentialLeaseEffectiveContextProvider {
  resolve(query: CredentialLeaseAuthorizationQuery): Promise<EffectiveContext>;
}

export interface PersistedCredentialLeaseAuthorizerOptions {
  readonly contextProvider: CredentialLeaseEffectiveContextProvider;
  readonly policyRepository: AuthorizationPolicyRepository;
  readonly decisionId: () => string;
}

/**
 * Evaluates credential lease access through the canonical persisted
 * authorization policy. The application boundary remains responsible for
 * producing a verified EffectiveContext; this adapter never infers tenant or
 * organization scope from the lease request.
 */
export class PersistedCredentialLeaseAuthorizer implements CredentialLeaseAuthorizer {
  readonly #contextProvider: CredentialLeaseEffectiveContextProvider;
  readonly #policyRepository: AuthorizationPolicyRepository;
  readonly #decisionId: () => string;

  constructor(options: PersistedCredentialLeaseAuthorizerOptions) {
    this.#contextProvider = options.contextProvider;
    this.#policyRepository = options.policyRepository;
    this.#decisionId = options.decisionId;
  }

  async authorize(
    query: CredentialLeaseAuthorizationQuery,
  ): Promise<CredentialLeaseAuthorizationDecision> {
    const decisionId = stable(this.#decisionId(), 'CREDENTIAL_LEASE_DECISION_ID_INVALID');
    const context = await this.#contextProvider.resolve(query);

    if (
      context.tenantId !== query.tenantId
      || context.subjectId !== query.requestedBySubjectId
    ) {
      return {
        decisionId,
        allowed: false,
        reasonKey: 'CREDENTIAL_CONTEXT_MISMATCH',
      };
    }

    const input = await buildAuthorizationInput(this.#policyRepository, {
      context,
      query: {
        action: query.action,
        intent: 'act',
        resource: {
          type: 'connector-credential',
          id: query.connectorKey,
          tenantId: query.tenantId,
          organizationId: context.organizationId,
          classification: 'sensitive',
          compartment: 'provider-credentials',
        },
      },
    });
    const decision = authorize(input);

    return {
      decisionId,
      allowed: decision.allowed,
      reasonKey: decision.reasonKey,
    };
  }
}

function stable(value: string, code: string): string {
  if (
    value.length === 0
    || value !== value.trim()
    || /[\r\n\t]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}
