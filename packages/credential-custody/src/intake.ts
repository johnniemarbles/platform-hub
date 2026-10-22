import { CustodyError, type CustodyMode } from './index.ts';
import { credentialFingerprint } from './fingerprint.ts';
import { probeFor } from './probe-dispatch.ts';
import type { ProbeResult } from './probe.ts';
import { delegatedSecretPath, type SecretVault } from './secret-vault.ts';
import { WrappingKeyStore, zeroise, type WrappedSecretEnvelope } from './wrapping.ts';

export interface CredentialIntakeRequest {
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly custodyMode: Extract<CustodyMode, 'DELEGATED'>;
  readonly envelope: WrappedSecretEnvelope;
  readonly parameters: Readonly<Record<string, string>>;
  readonly correlationId: string;
}

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

    let vaultSecret: Buffer | null = null;
    try {
      const plaintext = secret.toString('utf8');
      if (plaintext.trim().length === 0) {
        throw new CustodyError('CUSTODY_PAYLOAD_INVALID', 'The credential is empty.');
      }

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
        } satisfies CredentialIntakeResult;
      }

      vaultSecret = runtimeCredentialPayload(request.providerKey, plaintext, request.parameters);
      const fingerprint = credentialFingerprint(vaultSecret.toString('utf8'), this.deps.fingerprintKey);
      const version = await this.deps.vault.nextVersion(request.tenantId, request.connectorKey);

      let written;
      try {
        written = await this.deps.vault.write({
          tenantId: request.tenantId,
          connectorKey: request.connectorKey,
          providerKey: request.providerKey,
          secret: vaultSecret,
          custodyMode: request.custodyMode,
        });
      } catch (error) {
        throw new CustodyError(
          'CUSTODY_VAULT_WRITE_FAILED',
          `The credential could not be written to the vault: ${(error as Error).message}`,
        );
      }

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
      if (vaultSecret !== null) zeroise(vaultSecret);
      zeroise(secret);
    }
  }
}

function runtimeCredentialPayload(
  providerKey: string,
  plaintextSecret: string,
  parameters: Readonly<Record<string, string>>,
): Buffer {
  const normalizedProvider = providerKey.trim().toLowerCase();
  if (
    normalizedProvider === 'twilio'
    || normalizedProvider === 'twilio-sms'
    || normalizedProvider === 'twilio-whatsapp'
    || normalizedProvider === 'twilio-voice'
  ) {
    const accountSid = parameters.accountSid?.trim() ?? '';
    if (accountSid.length === 0) {
      throw new CustodyError(
        'CUSTODY_PAYLOAD_INVALID',
        'Twilio Account SID is required for a runtime-capable credential.',
      );
    }
    return Buffer.from(JSON.stringify({
      accountSid,
      authToken: plaintextSecret,
      ...(parameters.messagingServiceSid?.trim()
        ? { messagingServiceSid: parameters.messagingServiceSid.trim() }
        : {}),
    }), 'utf8');
  }

  return Buffer.from(plaintextSecret, 'utf8');
}

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
    bulkAllocationMultiplier: next === 'VALID' ? 1 : next === 'FAILING' ? 0.5 : 0,
    transactionalAllocationMultiplier: next === 'INVALID' ? 0 : 1,
    ...(input.probeError !== undefined ? { error: input.probeError } : {}),
  };
}
