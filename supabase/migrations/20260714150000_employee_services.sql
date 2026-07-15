-- Employee ↔ Service assignment (many-to-many).
-- One source of truth for "which services does this employee work on" /
-- "which employees belong to this service" — both directions read the same
-- junction, so they can never drift out of sync.
--
-- Powers:
--   • Settings → Employees: assign services on the employee form
--   • Settings → Services: assign employees on the service form
--   • Contributions: only employees of the task's service are offered for scoring
--   • tasks.view_by_service: restrict task visibility to assigned services

CREATE TABLE IF NOT EXISTS public.employee_services (
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  service_id  UUID NOT NULL REFERENCES public.services(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, service_id)
);

-- Composite PK already indexes (employee_id, service_id); add the reverse
-- lookup for "employees of a service" (contributions filtering, service form).
CREATE INDEX IF NOT EXISTS employee_services_service_idx ON public.employee_services (service_id);

ALTER TABLE public.employee_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.employee_services;
CREATE POLICY "Enable read access for all users"
ON public.employee_services FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Enable all access for admin users" ON public.employee_services;
CREATE POLICY "Enable all access for admin users"
ON public.employee_services FOR ALL
USING (true)
WITH CHECK (true);

-- ── Permission: restrict task visibility to assigned services ────────────────
-- Opt-in restriction. Resolution order (most → least visibility):
--   tasks.view_all          → every task (managers/admins; admins bypass anyway)
--   tasks.view_by_service   → tasks whose service is assigned to the employee,
--                             plus tasks they personally worked on
--   neither                 → legacy behaviour (unchanged: all tasks visible)
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'tasks', 'view_by_service', 'tasks.view_by_service',
  'Restrict to assigned services',
  'User only sees tasks belonging to the services assigned to them (plus tasks they worked on). Ignored when "View all tasks" is also granted.',
  15
)
ON CONFLICT (key) DO NOTHING;
