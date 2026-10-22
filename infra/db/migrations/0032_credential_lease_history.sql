BEGIN;

CREATE TABLE platform.credential_lease_events (
  event_id uuid PRIMARY KEY,
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  tenant_id uuid NOT NULL
    REFERENCES platform.tenants(tenant_id) ON DELETE CASCADE,
  requested_by_subject_id text NOT NULL
    CHECK (btrim(requested_by_subject_id) <> ''),
  connector_key text NOT NULL CHECK (btrim(connector_key) <> ''),
  credential_reference text NOT NULL CHECK (
    credential_reference ~ '^(secret|vault|kms|provider-secret)://[^[:space:]]+$'
  ),
  purpose text NOT NULL CHECK (btrim(purpose) <> ''),
  authorization_decision_id text NOT NULL
    CHECK (btrim(authorization_decision_id) <> ''),
  authorization_reason_key text NOT NULL
    CHECK (btrim(authorization_reason_key) <> ''),
  outcome text NOT NULL CHECK (outcome IN ('ISSUED', 'DENIED', 'FAILED')),
  lease_reference text,
  issuer_audit_reference text,
  failure_reason_key text,
  requested_at timestamptz NOT NULL,
  issued_at timestamptz,
  expires_at timestamptz,
  recorded_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  evidence_refs text[] NOT NULL CHECK (
    cardinality(evidence_refs) > 0
    AND array_position(evidence_refs, NULL) IS NULL
  ),
  UNIQUE (tenant_id, request_id),
  CHECK (recorded_at >= requested_at),
  CHECK (
    (outcome = 'ISSUED'
      AND btrim(lease_reference) <> ''
      AND btrim(issuer_audit_reference) <> ''
      AND failure_reason_key IS NULL
      AND issued_at IS NOT NULL
      AND expires_at > issued_at
      AND expires_at <= issued_at + interval '900 seconds')
    OR (outcome IN ('DENIED', 'FAILED')
      AND lease_reference IS NULL
      AND issuer_audit_reference IS NULL
      AND issued_at IS NULL
      AND expires_at IS NULL
      AND btrim(failure_reason_key) <> '')
  )
);

CREATE INDEX credential_lease_events_connector_idx
  ON platform.credential_lease_events (
    tenant_id, connector_key, recorded_at DESC
  );

CREATE OR REPLACE FUNCTION platform.reject_credential_lease_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Credential lease history is immutable';
END;
$$;

CREATE TRIGGER credential_lease_events_immutable
BEFORE UPDATE OR DELETE ON platform.credential_lease_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_credential_lease_event_mutation();

ALTER TABLE platform.credential_lease_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credential_lease_events FORCE ROW LEVEL SECURITY;

CREATE POLICY credential_lease_events_select
  ON platform.credential_lease_events
  FOR SELECT
  USING (tenant_id = platform.current_tenant_id());

CREATE POLICY credential_lease_events_insert
  ON platform.credential_lease_events
  FOR INSERT
  WITH CHECK (tenant_id = platform.current_tenant_id());

COMMIT;
