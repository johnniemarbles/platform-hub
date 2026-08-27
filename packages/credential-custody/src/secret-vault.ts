import type { CustodyMode } from './index.js';

/**
 * Design spec §3.2 — trust boundaries.
 *
 * The custody service has KMS write and NO database access. The control-plane
 * API has database access and NO KMS decrypt. Neither tier alone can
 * exfiltrate and persist.
 *
 * This port is the KMS/Vault side of that asymmetry. Implementations live in
 * an infrastructure package, never here.
 */

export interface SecretWriteRequest {
  readonly tenantId: string;
  readonly connectorKey: string;
  readonly providerKey: string;
  /** Plaintext. In memory only. Implementations must not log or buffer it. */
  readonly secret: Buffer;
  readonly custodyMode: Extract<CustodyMode, 'DELEGATED'>;
}

export interface SecretWriteResult {
  /** e.g. vault://tenant/{tenantId}/connector/{connectorKey}/v1 */
  readonly reference: string;
  readonly keyVersion: string;
  readonly writtenAt: string;
}

export interface SecretVault {
  write(request: SecretWriteRequest): Promise<SecretWriteResult>;
  /** Reference rotation only. The value itself rotates in the vault, not here. */
  nextVersion(tenantId: string, connectorKey: string): Promise<string>;
}

/**
 * §2.2 — the reference path is derived, never supplied by a caller.
 * A caller-supplied path is a path-traversal primitive into another tenant.
 */
export function delegatedSecretPath(tenantId: string, connectorKey: string, version: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    throw new Error('tenantId must be a UUID');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(connectorKey)) {
    throw new Error('connectorKey contains characters that are not path-safe');
  }
  if (!/^v[0-9]{1,6}$/.test(version)) {
    throw new Error('version must look like v1');
  }
  return `vault://tenant/${tenantId}/connector/${connectorKey}/${version}`;
}

/**
 * Mode 2 (§2.1) — EXPADIO stores a pointer and an assumable role, never a value.
 * The lease issuer gains a second resolver strategy behind the same
 * CredentialLease interface. No pipeline change.
 */
export interface CustomerReferencedBinding {
  readonly externalSecretArn: string;
  readonly assumeRoleArn: string;
  readonly externalId: string;
}

export function validateCustomerReferencedBinding(
  binding: CustomerReferencedBinding,
): { ok: true } | { ok: false; reason: string } {
  if (!/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/.test(binding.externalSecretArn)) {
    return { ok: false, reason: 'externalSecretArn is not a Secrets Manager ARN' };
  }
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(binding.assumeRoleArn)) {
    return { ok: false, reason: 'assumeRoleArn is not an IAM role ARN' };
  }
  // An external ID is what stops the confused-deputy attack on a cross-account role.
  if (binding.externalId.length < 16) {
    return { ok: false, reason: 'externalId must be at least 16 characters' };
  }
  return { ok: true };
}
