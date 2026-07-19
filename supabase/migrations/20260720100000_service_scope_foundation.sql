-- ─────────────────────────────────────────────────────────────────────────────
-- Service Scoping — foundation (Phase 0). No behaviour change on its own.
--
-- Two independent filters share this data layer:
--   A. Employee → their assigned services (and therefore only the clients who
--      buy them). Opt-in per designation; inert until `scope.by_service` is
--      granted to someone.
--   B. Client → the services that client is actually committed to, so picking
--      Sea Star stops offering Video Editing. Not permission-gated; guarded by
--      a company_settings kill switch instead.
--
-- The commitment record lives on client_service_pricing — the only client↔
-- service table, already declared the source of truth in
-- src/lib/services/intake-server.ts and migration 20260621000000. This makes
-- that role explicit: a row means "committed", `price` stays optional so a
-- service can be committed before a rate is agreed, and removal becomes
-- deactivation so price history survives (deleting a row silently breaks
-- historical commission recompute in lib/payroll/compute.ts).
--
-- Canonical predicate, to be used by every reader:
--     committed  ⇔  row exists AND is_active IS NOT FALSE
--
-- Rollback: supabase/rollbacks/20260720100000_service_scope_foundation_down.sql
-- Verify:   scripts/verify-service-scope.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Commitment semantics on client_service_pricing ────────────────────────

UPDATE public.client_service_pricing SET is_active = true WHERE is_active IS NULL;

ALTER TABLE public.client_service_pricing
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN is_active SET NOT NULL;

ALTER TABLE public.client_service_pricing
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES public.employees(id) ON DELETE SET NULL;

-- The hot paths: "services committed by this client" and "clients committed to
-- this service" (the latter drives employee → visible clients).
CREATE INDEX IF NOT EXISTS csp_commitment_idx
  ON public.client_service_pricing (client_id, service_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS csp_service_commitment_idx
  ON public.client_service_pricing (service_id) WHERE is_active;

-- ── 2. employee_services RLS fix ─────────────────────────────────────────────
-- Shipped in 20260714150000 with `USING (true)` and no TO clause, so the
-- policies apply to PUBLIC — including the `anon` role whose key ships in
-- every browser bundle. Same defect class as the offer tables
-- (20260718120000). Real authorization is app-level; every server read here
-- uses the service-role client, which bypasses RLS entirely.

DROP POLICY IF EXISTS "Enable read access for all users" ON public.employee_services;
DROP POLICY IF EXISTS "Enable all access for admin users" ON public.employee_services;
DROP POLICY IF EXISTS employee_services_authenticated_all ON public.employee_services;
CREATE POLICY employee_services_authenticated_all ON public.employee_services
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS employee_services_employee_idx
  ON public.employee_services (employee_id);

-- ── 3. Append-only assignment audit ──────────────────────────────────────────
-- Typed columns, not JSONB detail: "filter by employee / client / service /
-- date" must be a plain indexed query. activity_logs already records
-- `services_assigned`, but only as a whole-set snapshot with no prior value
-- and no per-pair action, so it cannot answer "when did X lose service Y".
-- scope_kind is open text so future dimensions (branch, department, team)
-- reuse this table rather than needing their own.

CREATE TABLE IF NOT EXISTS public.service_scope_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind  TEXT NOT NULL,          -- 'employee_service' | 'client_service'
  employee_id UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  client_id   UUID REFERENCES public.clients(id)   ON DELETE SET NULL,
  service_id  UUID REFERENCES public.services(id)  ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK (action IN ('added','removed','activated','deactivated')),
  old_value   JSONB,
  new_value   JSONB,
  actor_id    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  source      TEXT NOT NULL DEFAULT 'ui'
              CHECK (source IN ('ui','matrix','import','backfill','api')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_scope_audit_employee_idx
  ON public.service_scope_audit (employee_id, created_at DESC) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_scope_audit_client_idx
  ON public.service_scope_audit (client_id, created_at DESC)   WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_scope_audit_service_idx
  ON public.service_scope_audit (service_id, created_at DESC)  WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_scope_audit_created_idx
  ON public.service_scope_audit (created_at DESC);

-- Append-only, enforced in the database. RLS alone would not stop the
-- service-role client the whole app writes with, so this is a trigger.
CREATE OR REPLACE FUNCTION public.service_scope_audit_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service_scope_audit is append-only (attempted %)', TG_OP;
END $$;

DROP TRIGGER IF EXISTS service_scope_audit_no_mutate ON public.service_scope_audit;
CREATE TRIGGER service_scope_audit_no_mutate
  BEFORE UPDATE OR DELETE ON public.service_scope_audit
  FOR EACH ROW EXECUTE FUNCTION public.service_scope_audit_append_only();

ALTER TABLE public.service_scope_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_scope_audit_authenticated_all ON public.service_scope_audit;
CREATE POLICY service_scope_audit_authenticated_all ON public.service_scope_audit
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 4. Permissions ───────────────────────────────────────────────────────────
-- Two keys, not a per-module matrix. Dimension-qualified names so a future
-- scope.by_branch sits beside them without a rename.
--
-- NOTE: deliberately NOT granted to admin designations here — admins bypass
-- the catalog anyway, and `scope.by_service` is a RESTRICTION: auto-granting
-- it would restrict every admin the moment this migration runs.

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('scope', 'by_service', 'scope.by_service',
   'Restrict to assigned services',
   'User only sees the services assigned to them, and only the clients who buy those services. Leave OFF for admin, task-manager and finance designations.',
   16),
  ('scope', 'view_all', 'scope.view_all',
   'See all services and clients',
   'Explicit escape hatch: overrides "Restrict to assigned services" and shows everything.',
   17)
ON CONFLICT (key) DO NOTHING;

-- ── 5. Kill switch for the client→service narrowing ──────────────────────────
-- Feature A needs no flag (granting nobody the permission already makes it
-- inert, per-designation). Feature B applies to everyone the day it ships, so
-- it gets an admin-flippable switch — a company_settings row, not an env var,
-- so turning it off never requires a deploy.

INSERT INTO public.company_settings (key, value)
VALUES ('scope_client_services', 'on')
ON CONFLICT (key) DO NOTHING;
