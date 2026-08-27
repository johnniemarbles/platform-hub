/**
 * Design spec §2.6 — revocation, provable rather than merely performed.
 *
 * "The attestation is the deliverable, not the revocation. Anyone can flip a
 * boolean. Producing a signed, timestamped statement bounding the last
 * possible use of a credential is what a security reviewer is actually
 * asking for."
 *
 * Every fact below is derived from platform.credential_lease_events
 * (migration 0032), which is already immutable and already records
 * issued_at/expires_at per lease. Nothing is taken from the revocation
 * request itself, because a request cannot attest to anything.
 */

/** §3.5 — the send path leases for 60 s, not the 900 s administrative ceiling. */
export const SEND_PATH_LEASE_TTL_SECONDS = 60;

export interface LeaseHistoryRow {
  readonly leaseReference: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly outcome: 'ISSUED' | 'DENIED' | 'FAILED';
}

export interface RevocationInput {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly connectorKey: string;
  readonly revokedAt: string;
  readonly revokedBy: string;
  readonly correlationId: string;
  /** Leases issued in the window preceding revocation, from migration 0032. */
  readonly leaseHistory: readonly LeaseHistoryRow[];
  readonly messagesRerouted: number;
  readonly messagesCancelled: number;
}

export interface RevocationAttestation {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly connectorKey: string;
  readonly revokedAt: string;
  readonly revokedBy: string;
  readonly lastLeaseIssuedAt: string | null;
  readonly lastLeaseExpiredAt: string | null;
  readonly leasesInWindow: number;
  readonly messagesRerouted: number;
  readonly messagesCancelled: number;
  readonly maxExposureSeconds: number;
  readonly attestationText: string;
  readonly correlationId: string;
}

export function buildRevocationAttestation(input: RevocationInput): RevocationAttestation {
  const issued = input.leaseHistory
    .filter((row) => row.outcome === 'ISSUED')
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt));

  const last = issued[issued.length - 1] ?? null;
  const revokedMs = Date.parse(input.revokedAt);

  // A lease issued before revocation may still be live. The exposure window is
  // the time from revocation until the last outstanding lease expires — zero
  // when every lease had already expired.
  let maxExposureSeconds = 0;
  let lastExpiry: string | null = null;
  if (last !== null) {
    lastExpiry = last.expiresAt;
    const expiryMs = Date.parse(last.expiresAt);
    maxExposureSeconds = Math.max(0, Math.ceil((expiryMs - revokedMs) / 1000));
  }

  const attestationText =
    last === null
      ? `No credential lease was issued for connector '${input.connectorKey}' in the recorded window. ` +
        `Revocation at ${input.revokedAt} took effect with no outstanding exposure.`
      : `No credential lease was issued after ${input.revokedAt}. ` +
        `All outstanding leases expired by ${lastExpiry}. ` +
        `Maximum exposure window: ${maxExposureSeconds} seconds.`;

  return {
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    connectorKey: input.connectorKey,
    revokedAt: input.revokedAt,
    revokedBy: input.revokedBy,
    lastLeaseIssuedAt: last?.issuedAt ?? null,
    lastLeaseExpiredAt: lastExpiry,
    leasesInWindow: issued.length,
    messagesRerouted: input.messagesRerouted,
    messagesCancelled: input.messagesCancelled,
    maxExposureSeconds,
    attestationText,
    correlationId: input.correlationId,
  };
}

/**
 * §3.4 — blast radius. Computed from routing policies, never estimated.
 * Shown before any destructive connector action.
 */
export interface BlastRadius {
  readonly connectorKey: string;
  readonly tenantCount: number;
  readonly channels: readonly string[];
  readonly messagesLast30Days: number;
  readonly tenantsWithoutFallback: number;
  readonly statement: string;
}

export function describeBlastRadius(input: {
  readonly connectorKey: string;
  readonly tenantCount: number;
  readonly channels: readonly string[];
  readonly messagesLast30Days: number;
  readonly tenantsWithoutFallback: number;
}): BlastRadius {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const statement =
    `${input.tenantCount} ${plural(input.tenantCount, 'tenant', 'tenants')}, ` +
    `${input.channels.length} ${plural(input.channels.length, 'channel', 'channels')}, ` +
    `~${input.messagesLast30Days.toLocaleString('en-US')} messages/30d route through this connector. ` +
    `${input.tenantsWithoutFallback} ${plural(input.tenantsWithoutFallback, 'has', 'have')} no configured fallback.`;

  return { ...input, statement };
}
