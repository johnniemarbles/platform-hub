import { CustodyError, type CustodyMode } from './index.ts';
import { credentialFingerprint } from './fingerprint.ts';
import { probeFor, type ProbeResult } from './probe.ts';
import { delegatedSecretPath, type SecretVault } from './secret-vault.ts';
import { WrappingKeyStore, zeroise, type WrappedSecretEnvelope } from './wrapping.ts';

/**
 * Design spec §2.2 — Mode 1 intake, steps 4–8.
 *
 * unwrap in memory → probe the provider → write to vault → zeroise buffers.
 *
 * The plaintext exists inside this function and nowhere else. It is never
 * returned, never logged, never placed on an object that outlives the call.
 */

export interface CredentialIntakeRequest {
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly custodyMode: Extract<CustodyMode, 'DELEGATED'>;
  readonly envelope: WrappedSecretEnvelope;
  /** Non-secret companion fields: accountSid, region, apiKey, domain. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly correlationId: string;
}

/**
 * What crosses back to the control plane. Note what is absent: there is no
 * field here capable of holding a secret, and no field that could be widened
 * into one without a type change a reviewer would see.
 */
export interface CredentialIntakeResult {
  readonly credentialRef: string;
  readonly keyVersion: string;
  readonly fingerprint: string;
  readonly detectedCapabilities: readonly string[];
  readonly probeStatus: 'VALID' | 'INVALID';
  readonly warnings: ProbeResult['warnings'];
  readonly probedAt: string;
}

export interface CredentialIntakeDependencies {
  readonly wrappingKeys: WrappingKeyStore;
  readonly vault: SecretVault;
  readonly fingerprintKey: Buffer;
  readonly fetchImpl?: typeof fetch;
}

export class CredentialIntakeService {
  private readonly deps: CredentialIntakeDependencies;

  constructor(deps: CredentialIntakeDependencies) {
    this.deps = deps;
  }

  async intake(request: CredentialIntakeRequest): Promise<CredentialIntakeResult> {
    const probe = probeFor(request.providerKey);
    if (probe === null) {
      throw new CustodyError(
        'CUSTODY_PROVIDER_UNSUPPORTED',
        `No intake probe is registered for provider '${request.providerKey}'.`,
      );
    }

    let secret: Buffer;
    try {
      secret = this.deps.wrappingKeys.unwrap(request.envelope);
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'CUSTODY_WRAPPING_KEY_EXPIRED') {
        throw new CustodyError(
          'CUSTODY_WRAPPING_KEY_EXPIRED',
          'The wrapping key expired before the credential arrived. Start the form again.',
        );
      }
      if (message === 'CUSTODY_WRAPPING_KEY_UNKNOWN') {
        throw new CustodyError(
          'CUSTODY_WRAPPING_KEY_UNKNOWN',
          'This wrapping key is unknown or has already been used.',
        );
      }
      throw new CustodyError('CUSTODY_UNWRAP_FAILED', 'The credential envelope could not be opened.');
    }

    try {
      const plaintext = secret.toString('utf8');
      if (plaintext.trim().length === 0) {
        throw new CustodyError('CUSTODY_PAYLOAD_INVALID', 'The credential is empty.');
      }

      // §2.4 — never persist a credential that has never succeeded once.
      const result = await probe.probe({
        providerKey: request.providerKey,
        secret: plaintext,
        parameters: request.parameters,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
      });

      if (!result.valid) {
        return {
          credentialRef: '',
          keyVersion: '',
          fingerprint: '',
          detectedCapabilities: [],
          probeStatus: 'INVALID',
          warnings: result.warnings,
          probedAt: result.checkedAt,
          ...(result.error !== undefined ? {} : {}),
        } satisfies CredentialIntakeResult;
      }

      const fingerprint = credentialFingerprint(plaintext, this.deps.fingerprintKey);
      const version = await this.deps.vault.nextVersion(request.tenantId, request.connectorKey);

      let written;
      try {
        written = await this.deps.vault.write({
          tenantId: request.tenantId,
          connectorKey: request.connectorKey,
          providerKey: request.providerKey,
          secret,
          custodyMode: request.custodyMode,
        });
      } catch (error) {
        throw new CustodyError(
          'CUSTODY_VAULT_WRITE_FAILED',
          `The credential could not be written to the vault: ${(error as Error).message}`,
        );
      }

      // The vault decides the reference; we assert it matches the derived,
      // tenant-scoped path so a misconfigured vault cannot cross tenants.
      const expected = delegatedSecretPath(request.tenantId, request.connectorKey, version);
      if (written.reference !== expected) {
        throw new CustodyError(
          'CUSTODY_VAULT_WRITE_FAILED',
          'The vault returned a reference outside this tenant\'s namespace.',
        );
      }

      return {
        credentialRef: written.reference,
        keyVersion: written.keyVersion,
        fingerprint,
        detectedCapabilities: result.detectedCapabilities,
        probeStatus: 'VALID',
        warnings: result.warnings,
        probedAt: result.checkedAt,
      };
    } finally {
      // §2.2 step 8. Runs on every path, including a thrown probe error.
      zeroise(secret);
    }
  }
}

/**
 * §2.7 — continuous credential health.
 *
 * A key that worked at setup fails later: rotated by the customer, permissions
 * narrowed, account suspended, card declined. Silence here is the worst outcome.
 *
 * FAILING fires before sends fail. A FAILING BYOK connector halves its
 * bulk-plane allocation immediately and leaves transactional untouched.
 * Marketing degrades first. Always.
 */
export interface CredentialHealthTransition {
  readonly connectorKey: string;
  readonly previous: 'VALID' | 'FAILING' | 'INVALID';
  readonly next: 'VALID' | 'FAILING' | 'INVALID';
  readonly consecutiveFailures: number;
  readonly bulkAllocationMultiplier: number;
  readonly transactionalAllocationMultiplier: number;
  readonly error?: string;
}

export function nextCredentialHealth(input: {
  readonly connectorKey: string;
  readonly previous: 'VALID' | 'FAILING' | 'INVALID';
  readonly consecutiveFailures: number;
  readonly probeValid: boolean;
  readonly probeError?: string;
}): CredentialHealthTransition {
  const failures = input.probeValid ? 0 : input.consecutiveFailures + 1;

  let next: 'VALID' | 'FAILING' | 'INVALID';
  if (input.probeValid) next = 'VALID';
  else if (failures >= 3) next = 'INVALID';
  else next = 'FAILING';

  return {
    connectorKey: input.connectorKey,
    previous: input.previous,
    next,
    consecutiveFailures: failures,
    // Marketing degrades first, always. Transactional is never reduced by a probe.
    bulkAllocationMultiplier: next === 'VALID' ? 1 : next === 'FAILING' ? 0.5 : 0,
    transactionalAllocationMultiplier: next === 'INVALID' ? 0 : 1,
    ...(input.probeError !== undefined ? { error: input.probeError } : {}),
  };
}
