-- ============================================================================
-- 0042_communication_decision_traces.sql
-- Design spec §4.3 / §7 — the Decision Trace.
--
-- routeConnector() in packages/provider-registry already returns
-- { considered, rejected } and the pipeline discards it at the function
-- boundary. This table is where it stops being discarded.
--
-- Retention asymmetry (§4.3): 30 days for SENT, 400 days for every refusal.
-- Refusals are the audit artifact and are rare; successes are the metric.
-- ============================================================================

BEGIN;

CREATE TABLE platform.communication_decision_traces (
  trace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(tenant_id) ON DELETE CASCADE,
  organization_id uuid,
  message_id uuid,
  kind text NOT NULL CHECK (kind IN ('DISPATCH', 'SIMULATION', 'WEBHOOK', 'REVOCATION')),
  outcome text NOT NULL CHECK (outcome IN (
    'SENT', 'QUEUED', 'REFUSED', 'THROTTLED', 'SUPPRESSED', 'CANCELLED', 'FAILED'
  )),
  reason_code text,
  stopped_at_gate integer CHECK (stopped_at_gate BETWEEN 1 AND 16),
  gates jsonb NOT NULL,
  connectors_considered jsonb NOT NULL DEFAULT '[]'::jsonb,
  connectors_rejected jsonb NOT NULL DEFAULT '{}'::jsonb,
  compliance_pack_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL CHECK (btrim(correlation_id) <> ''),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A simulation has no message; a dispatch that reached a provider must have one.
  CHECK (kind <> 'SIMULATION' OR message_id IS NULL),
  -- A non-SENT outcome must name the gate it stopped at and why.
  CHECK (
    outcome IN ('SENT', 'QUEUED')
    OR (reason_code IS NOT NULL AND stopped_at_gate IS NOT NULL)
  ),
  CHECK (jsonb_typeof(gates) = 'array')
);

CREATE INDEX communication_decision_traces_message_idx
  ON platform.communication_decision_traces (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX communication_decision_traces_tenant_time_idx
  ON platform.communication_decision_traces (tenant_id, created_at DESC);

CREATE INDEX communication_decision_traces_correlation_idx
  ON platform.communication_decision_traces (correlation_id);

CREATE INDEX communication_decision_traces_reason_idx
  ON platform.communication_decision_traces (tenant_id, reason_code, created_at DESC)
  WHERE reason_code IS NOT NULL;

CREATE INDEX communication_decision_traces_expiry_idx
  ON platform.communication_decision_traces (expires_at);

CREATE OR REPLACE FUNCTION platform.reject_decision_trace_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Decision traces are append-only';
END;
$$;

CREATE TRIGGER communication_decision_traces_immutable
BEFORE UPDATE ON platform.communication_decision_traces
FOR EACH ROW EXECUTE FUNCTION platform.reject_decision_trace_mutation();

ALTER TABLE platform.communication_decision_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_decision_traces FORCE ROW LEVEL SECURITY;

CREATE POLICY communication_decision_traces_select
  ON platform.communication_decision_traces
  FOR SELECT USING (tenant_id = platform.current_tenant_id());

CREATE POLICY communication_decision_traces_insert
  ON platform.communication_decision_traces
  FOR INSERT WITH CHECK (tenant_id = platform.current_tenant_id());

COMMIT;
