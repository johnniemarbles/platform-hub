-- ============================================================================
-- 0040_communication_byok_custody.sql
-- Design spec §4.1 — BYOK and custody.
-- Extends platform.connector_credentials with the custody ladder (§2.1),
-- fingerprints (§2.3), probe state (§2.4, §2.7), failure policy (§2.5),
-- and adds the revocation attestation table (§2.6).
-- ============================================================================

BEGIN;

ALTER TABLE platform.connector_credentials
  ADD COLUMN custody_mode text NOT NULL DEFAULT 'PLATFORM_MANAGED'
    CHECK (custody_mode IN (
      'PLATFORM_MANAGED', 'DELEGATED', 'CUSTOMER_REFERENCED', 'CUSTOMER_EGRESS'
    )),
  ADD COLUMN fingerprint text
    CHECK (fingerprint IS NULL OR fingerprint ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  ADD COLUMN state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN (
      'PENDING_PROBE', 'ACTIVE', 'FAILING', 'INVALID', 'REVOKED', 'SUPERSEDED'
    )),
  ADD COLUMN probe_status text
    CHECK (probe_status IS NULL OR probe_status IN ('VALID', 'FAILING', 'INVALID')),
  ADD COLUMN probe_checked_at timestamptz,
  ADD COLUMN probe_error text,
  ADD COLUMN probe_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN detected_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN failure_policy text NOT NULL DEFAULT 'HOLD_AND_RETRY'
    CHECK (failure_policy IN (
      'HOLD_AND_RETRY', 'FALLBACK_TRANSACTIONAL', 'REFUSE_IMMEDIATELY'
    )),
  ADD COLUMN hold_window_seconds integer NOT NULL DEFAULT 900
    CHECK (hold_window_seconds BETWEEN 0 AND 3600),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid,
  ADD COLUMN external_secret_arn text,
  ADD COLUMN external_assume_role_arn text;

-- Mode 2 (CUSTOMER_REFERENCED) requires both external pointers; no other mode may carry them.
ALTER TABLE platform.connector_credentials
  ADD CONSTRAINT custody_mode_external_pointers CHECK (
    (custody_mode = 'CUSTOMER_REFERENCED'
      AND btrim(coalesce(external_secret_arn, '')) <> ''
      AND btrim(coalesce(external_assume_role_arn, '')) <> '')
    OR (custody_mode <> 'CUSTOMER_REFERENCED'
      AND external_secret_arn IS NULL
      AND external_assume_role_arn IS NULL)
  );

-- REVOKED is terminal and must carry its actor and timestamp.
ALTER TABLE platform.connector_credentials
  ADD CONSTRAINT credential_revocation_complete CHECK (
    (state = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
    OR (state <> 'REVOKED' AND revoked_at IS NULL AND revoked_by IS NULL)
  );

-- Design spec §2.3: the same fingerprint under two tenants is a shared account
-- or a leak. Indexed so the duplicate check is a lookup, not a scan.
CREATE INDEX connector_credentials_fingerprint_idx
  ON platform.connector_credentials (fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE INDEX connector_credentials_probe_idx
  ON platform.connector_credentials (probe_status, probe_checked_at)
  WHERE state IN ('ACTIVE', 'FAILING');

-- ---------------------------------------------------------------------------
-- §2.6 — the attestation is the deliverable, not the revocation.
-- Timestamps are derived from platform.credential_lease_events (0032),
-- never from the revocation request. Immutable once written.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.credential_revocation_attestations (
  attestation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(tenant_id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id) ON DELETE CASCADE,
  connector_key text NOT NULL CHECK (btrim(connector_key) <> ''),
  revoked_at timestamptz NOT NULL,
  revoked_by uuid NOT NULL,
  last_lease_issued_at timestamptz,
  last_lease_expired_at timestamptz,
  leases_in_window integer NOT NULL DEFAULT 0 CHECK (leases_in_window >= 0),
  messages_rerouted integer NOT NULL DEFAULT 0 CHECK (messages_rerouted >= 0),
  messages_cancelled integer NOT NULL DEFAULT 0 CHECK (messages_cancelled >= 0),
  max_exposure_seconds integer NOT NULL CHECK (max_exposure_seconds >= 0),
  attestation_text text NOT NULL CHECK (btrim(attestation_text) <> ''),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_lease_expired_at IS NULL OR last_lease_issued_at IS NOT NULL),
  CHECK (last_lease_expired_at IS NULL OR last_lease_expired_at >= last_lease_issued_at)
);

CREATE INDEX credential_revocation_attestations_connector_idx
  ON platform.credential_revocation_attestations (tenant_id, connector_key, revoked_at DESC);

CREATE OR REPLACE FUNCTION platform.reject_attestation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Revocation attestations are immutable';
END;
$$;

CREATE TRIGGER credential_revocation_attestations_immutable
BEFORE UPDATE OR DELETE ON platform.credential_revocation_attestations
FOR EACH ROW EXECUTE FUNCTION platform.reject_attestation_mutation();

ALTER TABLE platform.credential_revocation_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credential_revocation_attestations FORCE ROW LEVEL SECURITY;

CREATE POLICY credential_revocation_attestations_select
  ON platform.credential_revocation_attestations
  FOR SELECT USING (tenant_id = platform.current_tenant_id());

CREATE POLICY credential_revocation_attestations_insert
  ON platform.credential_revocation_attestations
  FOR INSERT WITH CHECK (tenant_id = platform.current_tenant_id());

COMMIT;
