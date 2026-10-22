BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE OR REPLACE FUNCTION platform.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE platform.capabilities (
  capability_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  permitted_modes text[] NOT NULL DEFAULT ARRAY['A']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_modes_valid CHECK (permitted_modes <@ ARRAY['A','B','C','D']::text[])
);

CREATE TABLE platform.connectors (
  connector_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key text NOT NULL UNIQUE,
  provider_type text NOT NULL,
  provider_key text NOT NULL,
  ownership_scope text NOT NULL CHECK (ownership_scope IN ('PLATFORM','TENANT')),
  tenant_id uuid,
  region text,
  residency_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  compliance_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  health text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('HEALTHY','DEGRADED','UNKNOWN','UNHEALTHY')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  enabled boolean NOT NULL DEFAULT true,
  fallback_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_ownership_tenant CHECK (
    (ownership_scope = 'PLATFORM' AND tenant_id IS NULL)
    OR (ownership_scope = 'TENANT' AND tenant_id IS NOT NULL)
  )
);

CREATE TABLE platform.connector_capabilities (
  connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES platform.capabilities(capability_id) ON DELETE CASCADE,
  PRIMARY KEY (connector_id, capability_id)
);

-- Domain persistence contains only references to an external secret manager.
-- Raw or encrypted provider credential payloads do not belong in this schema.
CREATE TABLE platform.connector_credentials (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES platform.connectors(connector_id) ON DELETE CASCADE,
  credential_ref text NOT NULL,
  key_version text,
  rotated_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_ref_external CHECK (
    credential_ref ~ '^(secret|vault|kms|provider-secret)://[^[:space:]]+$'
  ),
  UNIQUE (connector_id, credential_ref)
);

CREATE TABLE platform.connector_routing_policies (
  policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL REFERENCES platform.capabilities(capability_id) ON DELETE CASCADE,
  allowed_connector_keys text[],
  denied_connector_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_regions text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_residency_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_compliance_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  prefer_tenant_owned boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_policy_window CHECK (effective_until IS NULL OR effective_until > effective_from),
  UNIQUE (tenant_id, capability_id)
);

CREATE TABLE platform.tenant_capability_bindings (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid,
  capability_id uuid NOT NULL REFERENCES platform.capabilities(capability_id),
  connector_id uuid REFERENCES platform.connectors(connector_id),
  mode text CHECK (mode IN ('A','B','C','D')),
  is_entitled boolean NOT NULL DEFAULT false,
  is_within_bounds boolean NOT NULL DEFAULT true,
  bound_violation_key text,
  grace_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (binding_id, tenant_id)
);

CREATE UNIQUE INDEX tenant_capability_binding_scope_uq
  ON platform.tenant_capability_bindings (
    tenant_id,
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_id
  );

CREATE TABLE platform.capability_proofs (
  proof_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  proof_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('MATCHED','PENDING','FAILED')),
  evidence_ref text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (binding_id, tenant_id)
    REFERENCES platform.tenant_capability_bindings(binding_id, tenant_id)
    ON DELETE CASCADE,
  UNIQUE (binding_id, proof_key)
);

CREATE TABLE platform.capability_state (
  binding_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'ACTIVE','PLATFORM_DEFAULT','PENDING_PROOF','DEGRADED','VIOLATING','SUSPENDED','LOCKED_BY_PLAN','NOT_CONFIGURED'
  )),
  reason_key text,
  blocking_step_key text,
  blocking_bound_key text,
  if_you_do_nothing jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  resolved_at timestamptz NOT NULL,
  PRIMARY KEY (binding_id),
  FOREIGN KEY (binding_id, tenant_id)
    REFERENCES platform.tenant_capability_bindings(binding_id, tenant_id)
    ON DELETE CASCADE
);

CREATE TABLE platform.capability_state_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  binding_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason_key text,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (binding_id, tenant_id)
    REFERENCES platform.tenant_capability_bindings(binding_id, tenant_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION platform.reject_capability_state_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'capability_state_events is append-only';
END;
$$;

CREATE TRIGGER capability_state_events_append_only
BEFORE UPDATE OR DELETE ON platform.capability_state_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_capability_state_event_mutation();

CREATE INDEX connector_capabilities_capability_idx ON platform.connector_capabilities(capability_id);
CREATE INDEX connectors_tenant_idx ON platform.connectors(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX capability_bindings_tenant_idx ON platform.tenant_capability_bindings(tenant_id);
CREATE INDEX capability_proofs_tenant_idx ON platform.capability_proofs(tenant_id);
CREATE INDEX capability_state_events_tenant_binding_idx ON platform.capability_state_events(tenant_id, binding_id, occurred_at);

ALTER TABLE platform.connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.connectors FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_tenant_visibility ON platform.connectors
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = platform.current_tenant_id());

ALTER TABLE platform.connector_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.connector_routing_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY routing_policy_tenant_isolation ON platform.connector_routing_policies
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.tenant_capability_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_capability_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_bindings_tenant_isolation ON platform.tenant_capability_bindings
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.capability_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.capability_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_proofs_tenant_isolation ON platform.capability_proofs
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.capability_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.capability_state FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_state_tenant_isolation ON platform.capability_state
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

ALTER TABLE platform.capability_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.capability_state_events FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_state_events_tenant_isolation ON platform.capability_state_events
  USING (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

COMMIT;
