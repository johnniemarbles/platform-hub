import type { GovernedCredentialLeaseService } from '@platform-hub/provider-registry';

export type CredentialLeaseService = Pick<GovernedCredentialLeaseService, 'issue'>;
