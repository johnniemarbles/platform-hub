-- =============================================================================
-- 0100_gate1_connector_grants.sql
-- Plan V3.1 rule 5: an app needs an explicit grant to use a tenant's connector.
-- "No silent fallback to an ungranted or unrelated key."
--
-- Depends on platform.connectors (0001) and extends the three-class model from
-- custody_mode (0040) with a per-app grant table.
-- =============================================================================

BEGIN;

-- 1. Record which app has been granted use of which connector.
--    Platform-operational credentials DO NOT appear here; by definition they are
--    not grantable to apps.
CREATE TABLE platform.connector_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,                                 -- the tenant that owns the credential
  app_id text NOT NULL CHECK (btrim(app_id) <> ''),
  connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id) ON DELETE CASCADE,
  credential_class text NOT NULL
    CHECK (credential_class IN ('tenant-byok', 'platform-provisioned')),
  granted_by uuid NOT NULL,                                -- authorization subject that granted it
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  purpose text,                                            -- short free text; audited not matched
  CONSTRAINT connector_grants_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  ),
  UNIQUE (tenant_id, app_id, connector_id)
);

CREATE INDEX connector_grants_live_idx
  ON platform.connector_grants (tenant_id, app_id, connector_id)
  WHERE revoked_at IS NULL;

-- 2. Server-side context: GUCs that the hub sets from the verified scope token.
--    Clients cannot set these; row-level security policies read them.
--    These are read via platform.current_tenant_id() (added in 0001) and the
--    helpers below. Setters are stored procedures so a privilege escalation
--    cannot bypass them from an ordinary query.
CREATE OR REPLACE FUNCTION platform.current_app_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.app_id', true), '') $$;

CREATE OR REPLACE FUNCTION platform.current_hierarchy_scope() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.hierarchy_scope', true), '') $$;

CREATE OR REPLACE FUNCTION platform.current_credential_class() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.credential_class', true), '') $$;

CREATE OR REPLACE FUNCTION platform.current_grant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.grant_id', true), '')::uuid
  $$;

-- Setter: hub-only. The hub calls this once per request after verifying the
-- scope token. The GUCs it sets are LOCAL to the transaction, so a connection
-- returned to a pool cannot leak context into the next request.
CREATE OR REPLACE FUNCTION platform.set_request_context(
  p_tenant_id uuid,
  p_app_id text,
  p_hierarchy_scope text,
  p_credential_class text,
  p_grant_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_credential_class NOT IN ('platform-operational', 'tenant-byok', 'platform-provisioned') THEN
    RAISE EXCEPTION 'invalid credential class: %', p_credential_class;
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  PERFORM set_config('app.app_id', p_app_id, true);
  PERFORM set_config('app.hierarchy_scope', p_hierarchy_scope, true);
  PERFORM set_config('app.credential_class', p_credential_class, true);
  PERFORM set_config('app.grant_id', COALESCE(p_grant_id::text, ''), true);
END $$;

-- 3. The grant check. Returns true iff:
--      a. the connector exists,
--      b. its ownership_scope matches the request's credential class,
--      c. for tenant-owned credentials, a live grant exists for (tenant, app).
--    The hub calls this before using any tenant-owned credential.
CREATE OR REPLACE FUNCTION platform.app_may_use_connector(
  p_tenant_id uuid,
  p_app_id text,
  p_connector_id uuid,
  p_credential_class text
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_ownership text;
  v_connector_tenant uuid;
BEGIN
  SELECT ownership_scope, tenant_id
    INTO v_ownership, v_connector_tenant
    FROM platform.connectors
   WHERE connector_id = p_connector_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Platform-operational credentials are only usable with the matching request class.
  IF v_ownership = 'PLATFORM' THEN
    RETURN p_credential_class = 'platform-operational';
  END IF;

  -- Tenant-owned: the tenant must match AND a live grant must exist for the app.
  IF v_connector_tenant IS DISTINCT FROM p_tenant_id THEN
    RETURN false;
  END IF;
  IF p_credential_class NOT IN ('tenant-byok', 'platform-provisioned') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM platform.connector_grants
     WHERE tenant_id = p_tenant_id
       AND app_id = p_app_id
       AND connector_id = p_connector_id
       AND credential_class = p_credential_class
       AND revoked_at IS NULL
  );
END $$;

COMMENT ON TABLE platform.connector_grants IS
  'Plan V3.1 rule 5: an app needs an explicit grant to use a tenant''s connector; no silent fallback. Platform-operational credentials never appear here.';

COMMIT;
