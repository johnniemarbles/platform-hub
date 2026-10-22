-- =============================================================================
-- 0000_hub_core_stubs.sql
--
-- Minimum core-side tables the hub's own migrations reference. In production
-- platform-core applies first and these tables already exist; this file is a
-- no-op in that case thanks to IF NOT EXISTS. In staging and in db-dryrun it
-- bootstraps a minimal shape so hub-side migrations can apply standalone.
--
-- Keep this file additive-only. If platform-core adds columns to these tables,
-- do NOT update them here — the real migration in platform-core owns the
-- schema; this file only guarantees the referenced tables exist by name.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
