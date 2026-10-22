-- ============================================================================
-- 0041_communication_enforcement.sql
-- Design spec §4.2 — closes G2 (no enforcement layer) and G3 (no plane separation).
--
-- comms_throttle_windows is PORTED FROM BEMP AS-IS (BEMP migration 0115 +
-- CommunicationThrottleService). The atomic INSERT ... ON CONFLICT DO UPDATE
-- counter is proven under concurrent instances; it is not redesigned here.
-- The only change is the added `plane` key column required by §0.5 / C14.
-- ============================================================================

BEGIN;

CREATE TABLE platform.communication_throttle_windows (
  tenant_id uuid NOT NULL,
  plane text NOT NULL CHECK (plane IN ('TRANSACTIONAL', 'BULK')),
  window_type text NOT NULL CHECK (window_type IN ('MINUTE', 'DAY')),
  window_key text NOT NULL CHECK (btrim(window_key) <> ''),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, plane, window_type, window_key)
);

CREATE INDEX communication_throttle_windows_updated_idx
  ON platform.communication_throttle_windows (updated_at);

-- ---------------------------------------------------------------------------
-- §0.5 / B16 — the transactional floor is reserved and never borrowable.
-- A campaign must never delay an OTP.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.communication_plane_budgets (
  tenant_id uuid NOT NULL,
  connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id) ON DELETE CASCADE,
  transactional_floor_pct integer NOT NULL DEFAULT 30
    CHECK (transactional_floor_pct BETWEEN 0 AND 100),
  transactional_max_per_minute integer CHECK (transactional_max_per_minute > 0),
  transactional_max_per_day integer CHECK (transactional_max_per_day > 0),
  bulk_max_per_minute integer CHECK (bulk_max_per_minute > 0),
  bulk_max_per_day integer CHECK (bulk_max_per_day > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id)
);

-- ---------------------------------------------------------------------------
-- §4.2 / B19 — spend caps. Breaker state is enforcement, not a dashboard signal.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.communication_spend_caps (
  tenant_id uuid PRIMARY KEY REFERENCES platform.tenants(tenant_id) ON DELETE CASCADE,
  daily_cap_minor_units bigint CHECK (daily_cap_minor_units IS NULL OR daily_cap_minor_units > 0),
  spent_today_minor_units bigint NOT NULL DEFAULT 0 CHECK (spent_today_minor_units >= 0),
  spend_day_key text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
  currency text NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  breaker_state text NOT NULL DEFAULT 'CLOSED'
    CHECK (breaker_state IN ('CLOSED', 'WARNING', 'OPEN')),
  breaker_opened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (breaker_state = 'OPEN' AND breaker_opened_at IS NOT NULL)
    OR (breaker_state <> 'OPEN' AND breaker_opened_at IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Target architecture §7 — dead letters carry metadata only.
-- The rejected payload body is deliberately absent: it may itself be
-- adversarial input. Enough to debug a rotated signing secret, no more.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.communication_webhook_dead_letters (
  dead_letter_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL CHECK (btrim(provider_key) <> ''),
  received_at timestamptz NOT NULL DEFAULT now(),
  signature_check_result text NOT NULL
    CHECK (signature_check_result IN ('FAILED', 'MISSING', 'REPLAYED', 'MALFORMED')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  correlation_id text,
  header_digest text,
  CONSTRAINT dead_letter_carries_no_payload CHECK (
    header_digest IS NULL OR header_digest ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX communication_webhook_dead_letters_provider_idx
  ON platform.communication_webhook_dead_letters (provider_key, received_at DESC);

ALTER TABLE platform.communication_throttle_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_throttle_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_throttle_windows_all
  ON platform.communication_throttle_windows
  FOR ALL USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.communication_plane_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_plane_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_plane_budgets_select
  ON platform.communication_plane_budgets
  FOR SELECT USING (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.communication_spend_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.communication_spend_caps FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_spend_caps_all
  ON platform.communication_spend_caps
  FOR ALL USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

COMMIT;
