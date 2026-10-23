/**
 * GET  /v1/credentials             — list connectors visible to the token
 * POST /v1/credentials/:id/revoke  — write an immutable revocation attestation
 *
 * RLS on connector_credentials isn't present in 0001; the hub filters
 * explicitly here using platform.current_tenant_id() set by withRequestContext.
 */
import { executeIdempotent, type IdempotencyStore } from '@platform-hub/enforcement';
import type { RouteDefinition, HandlerContext } from '../handler.ts';
import type { IncomingMessage } from 'node:http';

export interface CredentialRow {
  readonly connector_id: string;
  readonly connector_key: string;
  readonly provider_type: string;
  readonly provider_key: string;
  readonly ownership_scope: 'PLATFORM' | 'TENANT';
  readonly custody_mode: string | null;
  readonly fingerprint: string | null;
  readonly state: string | null;
  readonly probe_status: string | null;
  readonly probe_checked_at: string | null;
  readonly failure_policy: string | null;
}

export interface AttestationRow {
  readonly attestation_id: string;
  readonly connector_key: string;
  readonly revoked_at: string;
  readonly max_exposure_seconds: number;
  readonly leases_in_window: number;
  readonly messages_rerouted: number;
  readonly messages_cancelled: number;
  readonly attestation_text: string;
}

async function listCredentials({ tx, claims }: HandlerContext): Promise<unknown> {
  const common = `
    SELECT c.connector_id::text,
           c.connector_key, c.provider_type, c.provider_key, c.ownership_scope,
           cc.custody_mode, cc.fingerprint, cc.state, cc.probe_status,
           cc.probe_checked_at::text, cc.failure_policy
      FROM platform.connectors c
      LEFT JOIN platform.connector_credentials cc USING (connector_id)
     WHERE (cc.state IS NULL OR cc.state <> 'REVOKED')
  `;
  let rows: readonly CredentialRow[];
  if (claims.credentialClass === 'platform-operational') {
    const r = await tx.query<CredentialRow>(
      `${common}
         AND (c.ownership_scope = 'PLATFORM'
              OR c.tenant_id = platform.current_tenant_id())
       ORDER BY c.ownership_scope, c.connector_key`,
    );
    rows = r.rows;
  } else {
    const r = await tx.query<CredentialRow>(
      `${common}
         AND c.tenant_id = platform.current_tenant_id()
         AND EXISTS (
           SELECT 1 FROM platform.connector_grants g
            WHERE g.tenant_id        = platform.current_tenant_id()
              AND g.app_id           = platform.current_app_id()
              AND g.connector_id     = c.connector_id
              AND g.credential_class = platform.current_credential_class()
              AND g.revoked_at IS NULL
         )
       ORDER BY c.connector_key`,
    );
    rows = r.rows;
  }
  return {
    count: rows.length,
    credentials: rows.map((r) => ({
      connectorId: r.connector_id,
      connectorKey: r.connector_key,
      providerType: r.provider_type,
      providerKey: r.provider_key,
      ownership: r.ownership_scope,
      custodyMode: r.custody_mode,
      fingerprint: r.fingerprint,
      state: r.state,
      probe: r.probe_status ? { status: r.probe_status, checkedAt: r.probe_checked_at } : null,
      failurePolicy: r.failure_policy,
    })),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
  catch { throw new Error('BODY_INVALID_JSON'); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function credentialRoutes(idempotency: IdempotencyStore<AttestationRow>): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/v1/credentials',
      scope: { permission: 'credentials.read' },
      handler: listCredentials,
    },
    {
      method: 'POST',
      pattern: /^\/v1\/credentials\/[0-9a-f-]{36}\/revoke$/i,
      scope: { permission: 'credential.revoke' },
      handler: async (ctx, req) => {
        if (req.url === undefined) throw new Error('MISSING_URL');
        const match = /^\/v1\/credentials\/([0-9a-f-]{36})\/revoke$/i.exec(req.url);
        if (!match) throw new Error('ROUTE_NOT_FOUND');
        const connectorId = match[1]!;
        if (!UUID_RE.test(connectorId)) throw new Error('CONNECTOR_ID_INVALID');
        const body = await readJsonBody(req);
        const txt = typeof body['attestationText'] === 'string' ? body['attestationText'].trim() : '';
        const sec = Number(body['maxExposureSeconds']);
        const corr = typeof body['correlationId'] === 'string' ? body['correlationId'] : '';
        const key = typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : '';
        if (!txt) throw new Error('ATTESTATION_TEXT_REQUIRED');
        if (!Number.isFinite(sec) || sec < 0) throw new Error('MAX_EXPOSURE_INVALID');
        if (!UUID_RE.test(corr)) throw new Error('CORRELATION_ID_INVALID');
        if (!key) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
        const { tx, claims } = ctx;
        const { result, replayed } = await executeIdempotent(
          { tenantId: claims.tenantId, operation: 'credential.revoke', key },
          idempotency,
          async () => {
            const connector = await tx.query<{ connector_key: string; ownership_scope: 'PLATFORM' | 'TENANT' }>(
              `SELECT c.connector_key, c.ownership_scope
                 FROM platform.connectors c
                 LEFT JOIN platform.connector_credentials cc USING (connector_id)
                WHERE c.connector_id = $1
                  AND (c.ownership_scope = 'PLATFORM' OR c.tenant_id = platform.current_tenant_id())
                  AND (cc.state IS NULL OR cc.state <> 'REVOKED')`,
              [connectorId],
            );
            const row = connector.rows[0];
            if (!row) throw new Error('CONNECTOR_NOT_FOUND');
            const inserted = await tx.query<AttestationRow>(
              `INSERT INTO platform.credential_revocation_attestations
                 (tenant_id, connector_id, connector_key, revoked_at, revoked_by,
                  leases_in_window, messages_rerouted, messages_cancelled,
                  max_exposure_seconds, attestation_text, correlation_id)
               VALUES (platform.current_tenant_id(), $1, $2, now(), $3,
                       0, 0, 0, $4, $5, $6)
               RETURNING attestation_id::text, connector_key, revoked_at::text,
                         max_exposure_seconds, leases_in_window, messages_rerouted,
                         messages_cancelled, attestation_text`,
              [connectorId, row.connector_key, claims.sub, sec, txt, corr],
            );
            const attestation = inserted.rows[0];
            if (!attestation) throw new Error('ATTESTATION_INSERT_FAILED');
            await tx.query(
              `UPDATE platform.connector_credentials
                  SET state = 'REVOKED', revoked_at = now(), revoked_by = $2
                WHERE connector_id = $1`,
              [connectorId, claims.sub],
            );
            return attestation;
          },
        );
        return { ...result, replayed };
      },
    },
  ];
}
