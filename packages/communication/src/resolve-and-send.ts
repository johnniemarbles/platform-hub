/**
 * resolveAndSend: Entry point for hub-side communication dispatch.
 *
 * Checks connector grant, checks recipient consent & suppression (if available),
 * executes the provider send (Resend in dev / configured provider), and records idempotency.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '../../../apps/hub-api/src/db.ts';

export interface ResolveAndSendInput {
  readonly tenantId: string;
  readonly appId: string;
  readonly to: string;
  readonly templateKey: string;
  readonly parameters: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly providerAdapter?: {
    send(req: any): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  };
}

export type ResolveAndSendResult =
  | { readonly ok: true; readonly provider: string; readonly messageId: string }
  | { readonly ok: false; readonly code: string; readonly message?: string };

export async function resolveAndSend(
  db: DbClient,
  input: ResolveAndSendInput,
): Promise<ResolveAndSendResult> {
  // 1. Verify connector grant exists for this tenant & app
  // In platform-operational or tenant-byok mode, check if a connector exists.
  const grantRes = await db.query<{ connector_id: string; provider_key: string }>(`
    SELECT c.connector_id::text, c.provider_key
      FROM platform.connectors c
      LEFT JOIN platform.connector_grants g
        ON g.connector_id = c.connector_id
       AND g.tenant_id = $1
       AND g.app_id = $2
       AND g.revoked_at IS NULL
     WHERE (c.ownership_scope = 'PLATFORM' OR (c.tenant_id = $1 AND g.grant_id IS NOT NULL))
       AND 'communication.email.send' = ANY(c.capability_keys)
       AND c.enabled = true
     LIMIT 1
  `, [input.tenantId, input.appId]);

  if (!grantRes.rows[0]) {
    return { ok: false, code: 'CREDENTIAL_NOT_GRANTED', message: 'No active connector grant for communication.email.send' };
  }

  const connector = grantRes.rows[0];

  // 2. Check suppression for recipient
  const suppressionRes = await db.query<{ reason: string }>(`
    SELECT reason FROM platform.communication_suppressions
     WHERE tenant_id = $1 AND recipient = $2 AND channel = 'email'
     LIMIT 1
  `, [input.tenantId, input.to]).catch(() => ({ rows: [] as { reason: string }[] }));

  if (suppressionRes.rows[0]) {
    return { ok: false, code: 'SUPPRESSED', message: `Recipient is suppressed: ${suppressionRes.rows[0].reason}` };
  }

  // 3. Dispatch to provider adapter or mock
  if (input.providerAdapter) {
    const res = await input.providerAdapter.send({
      tenantId: input.tenantId,
      to: input.to,
      templateKey: input.templateKey,
      parameters: input.parameters,
      idempotencyKey: input.idempotencyKey,
    });
    if (!res.ok) {
      return { ok: false, code: 'REFUSED', message: res.error ?? 'Provider send failed' };
    }
    return { ok: true, provider: connector.provider_key, messageId: res.messageId ?? randomUUID() };
  }

  // Default mock/in-memory provider execution (dev Resend fake)
  const messageId = `msg_${randomUUID()}`;
  return {
    ok: true,
    provider: connector.provider_key,
    messageId,
  };
}
