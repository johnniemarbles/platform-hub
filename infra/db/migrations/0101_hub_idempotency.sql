-- =============================================================================
-- 0101_hub_idempotency.sql
--
-- Hub-side idempotency table. Replaces the in-memory store used by the Gate 2
-- enforcement package. A UNIQUE index on (tenant_id, operation, key) serialises
-- concurrent writes across workers: the first INSERT stores the result, every
-- replay reads the same row and returns the first value.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS platform.hub_idempotency (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(tenant_id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  key text NOT NULL CHECK (btrim(key) <> ''),
  first_result jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, key)
);

CREATE INDEX IF NOT EXISTS hub_idempotency_stored_at_idx
  ON platform.hub_idempotency (stored_at);

COMMENT ON TABLE platform.hub_idempotency IS
  'Hub-side idempotency: a duplicate submission under the same (tenant, operation, key) returns the first row''s result (plan V3.1 §Reliability rules).';

COMMIT;
