-- ============================================================================
-- 0043_credential_non_disclosure.sql
-- Design spec §3.3 — database-level non-disclosure, and §4.4 — RLS completion.
--
-- The branded CredentialReference type in packages/provider-registry stops
-- honest mistakes. These constraints stop the ORM-shaped ones and the
-- "temporarily paste the real key in during development" ones.
-- ============================================================================

BEGIN;

-- 0001 already constrains the shape. Add the length bound.
ALTER TABLE platform.connector_credentials
  ADD CONSTRAINT credential_ref_bounded_length
  CHECK (char_length(credential_ref) < 512);

-- Defence in depth: a smoke alarm, not a lock. Catches live provider secret
-- material in a reference column regardless of what the column is named.
ALTER TABLE platform.connector_credentials
  ADD CONSTRAINT no_embedded_secret_material
  CHECK (
    credential_ref !~ '(sk_live|sk-[A-Za-z0-9]{20}|SG\.[A-Za-z0-9_-]{20}|AKIA[0-9A-Z]{16}|xoxb-|AC[0-9a-f]{32}|-----BEGIN)'
  );

-- key_version is metadata, never material.
ALTER TABLE platform.connector_credentials
  ADD CONSTRAINT key_version_is_metadata
  CHECK (
    key_version IS NULL
    OR (char_length(key_version) <= 64
        AND key_version !~ '(sk_live|SG\.|AKIA[0-9A-Z]{16}|xoxb-|-----BEGIN)')
  );

-- ---------------------------------------------------------------------------
-- §4.4 — the schema-drift guard.
-- A code-review convention does not survive contact with a team; a test does.
-- This function is called by the CI drift test and by any operator who wants
-- to know whether a new table shipped without a policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.tenant_scoped_tables_missing_rls()
RETURNS TABLE (table_name text, reason text)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         CASE
           WHEN NOT c.relrowsecurity THEN 'ROW_LEVEL_SECURITY_DISABLED'
           WHEN NOT c.relforcerowsecurity THEN 'FORCE_ROW_LEVEL_SECURITY_DISABLED'
           ELSE 'NO_POLICY_DEFINED'
         END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'platform'
    AND c.relkind = 'r'
    AND a.attname = 'tenant_id'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND (
      NOT c.relrowsecurity
      OR NOT c.relforcerowsecurity
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
    );
$$;

COMMENT ON FUNCTION platform.tenant_scoped_tables_missing_rls() IS
  'Design spec §4.4. Returns empty on a healthy schema. CI fails the build on any row.';

COMMIT;
