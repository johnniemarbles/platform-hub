import {
  delegatedSecretPath,
  type SecretVault,
  type SecretWriteRequest,
  type SecretWriteResult,
} from '@platform-hub/credential-custody';

/**
 * Vault-backed secret store for the custody process.
 * Intentionally has no Postgres / local AES path — that belongs only to
 * colocated platform-web fallbacks during pre-cutover development.
 */
export class VaultSecretStore implements SecretVault {
  private readonly address: string;
  private readonly token: string;
  private readonly mount: string;

  constructor(address: string, token: string, mount = 'expadio') {
    this.address = address.replace(/\/+$/, '');
    this.token = token;
    this.mount = mount;
  }

  private dataPath(tenantId: string, connectorKey: string): string {
    return `${this.address}/v1/${this.mount}/data/tenant/${tenantId}/connector/${connectorKey}`;
  }

  private metadataPath(tenantId: string, connectorKey: string): string {
    return `${this.address}/v1/${this.mount}/metadata/tenant/${tenantId}/connector/${connectorKey}`;
  }

  async nextVersion(tenantId: string, connectorKey: string): Promise<string> {
    const response = await fetch(this.metadataPath(tenantId, connectorKey), {
      method: 'GET',
      headers: { 'X-Vault-Token': this.token },
    });
    if (response.status === 404) return 'v1';
    if (!response.ok) throw new Error(`Vault metadata read failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { current_version?: number } };
    return `v${(body.data?.current_version ?? 0) + 1}`;
  }

  async write(request: SecretWriteRequest): Promise<SecretWriteResult> {
    const version = await this.nextVersion(request.tenantId, request.connectorKey);
    const response = await fetch(this.dataPath(request.tenantId, request.connectorKey), {
      method: 'POST',
      headers: { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          secret: request.secret.toString('utf8'),
          providerKey: request.providerKey,
        },
      }),
    });
    if (!response.ok) throw new Error(`Vault write failed: HTTP ${response.status}`);
    return {
      reference: delegatedSecretPath(request.tenantId, request.connectorKey, version),
      keyVersion: version,
      writtenAt: new Date().toISOString(),
    };
  }
}

export function createCustodyVaultFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecretVault {
  const address = env.VAULT_ADDR?.trim();
  const token = env.VAULT_TOKEN?.trim();
  if (!address || !token) {
    throw new Error(
      'CUSTODY_VAULT_REQUIRED: custody-service requires VAULT_ADDR and VAULT_TOKEN (no local DB locker).',
    );
  }
  return new VaultSecretStore(address, token, env.VAULT_MOUNT?.trim() || 'expadio');
}
