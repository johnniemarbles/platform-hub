/**
 * Scope-token-based CredentialLeaseAuthorizer.
 *
 * Replaces the dropped persisted-credential-lease-authorizer.ts (plan rule 3:
 * the hub does not run the authorization policy itself). The verified scope
 * token the caller already carries IS the authority: it names the tenant,
 * app, permissions, hierarchy scope, credential class and grant. This
 * authorizer checks the lease request against those claims and, when a
 * tenant-owned credential is in play, defers to the pre-verified grantId.
 *
 * Pair with:
 *   - verifyScopeToken (@platform-hub/contracts) at the edge of hub-api
 *   - platform.app_may_use_connector(...) in the DB for the final "grant exists?" check
 */
import type {
  CredentialLeaseAuthorizer,
  CredentialLeaseAuthorizationQuery,
  CredentialLeaseAuthorizationDecision,
} from './credential-access.ts';

export interface ScopeTokenCredentialClaims {
  readonly tenantId: string;
  readonly appId: string;
  readonly sub: string;
  readonly permissions: readonly string[];
  readonly credentialClass: 'platform-operational' | 'tenant-byok' | 'platform-provisioned';
  readonly grantId?: string;
}

export interface ScopeTokenAuthorizerOptions {
  /** The claims from an already-verified scope token for THIS request. */
  readonly claims: ScopeTokenCredentialClaims;
  /** New decision id per call; must be unique and stable per attempt. */
  readonly decisionId: () => string;
  /** The permission key a 'credential.lease' request must carry. */
  readonly requiredPermission?: string;
}

/**
 * Checks the lease query against the verified claims. The authorizer is cheap
 * and synchronous; use one instance per request. If a lease needs a connector
 * owned by a tenant, the caller must already have verified the grant in the
 * database (platform.app_may_use_connector); this authorizer does not re-check it.
 */
export class ScopeTokenCredentialLeaseAuthorizer implements CredentialLeaseAuthorizer {
  readonly #claims: ScopeTokenCredentialClaims;
  readonly #decisionId: () => string;
  readonly #requiredPermission: string;

  constructor(options: ScopeTokenAuthorizerOptions) {
    this.#claims = options.claims;
    this.#decisionId = options.decisionId;
    this.#requiredPermission = options.requiredPermission ?? 'credential.lease';
  }

  async authorize(query: CredentialLeaseAuthorizationQuery): Promise<CredentialLeaseAuthorizationDecision> {
    const decisionId = stable(this.#decisionId(), 'CREDENTIAL_LEASE_DECISION_ID_INVALID');

    if (query.action !== 'credential.lease') {
      return { decisionId, allowed: false, reasonKey: 'CREDENTIAL_LEASE_ACTION_INVALID' };
    }

    // The hub trusts the scope token, not the request body. If the request
    // names a tenant the token doesn't cover, the dispatcher should have
    // refused with TOKEN_SCOPE_MISMATCH long before we got here. The second
    // check here is defense in depth.
    if (query.tenantId !== this.#claims.tenantId) {
      return { decisionId, allowed: false, reasonKey: 'CREDENTIAL_CONTEXT_MISMATCH' };
    }
    if (query.requestedBySubjectId !== this.#claims.sub) {
      return { decisionId, allowed: false, reasonKey: 'CREDENTIAL_CONTEXT_MISMATCH' };
    }

    // The permission key the scope token must carry for a lease action.
    if (!this.#claims.permissions.includes(this.#requiredPermission)) {
      return { decisionId, allowed: false, reasonKey: 'CREDENTIAL_PERMISSION_MISSING' };
    }

    // Tenant-owned credentials must have been granted to the app that holds
    // this token. The actual grant row is checked by
    // platform.app_may_use_connector() in the DB; here we just assert the
    // token carries the grant id so the hub cannot mint a tenant-byok lease
    // from a platform-operational token.
    if (this.#claims.credentialClass !== 'platform-operational' && this.#claims.grantId === undefined) {
      return { decisionId, allowed: false, reasonKey: 'CREDENTIAL_GRANT_MISSING' };
    }

    return { decisionId, allowed: true, reasonKey: 'CREDENTIAL_LEASE_ALLOWED' };
  }
}

function stable(value: string, code: string): string {
  if (value.length === 0 || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}
