-- Ownership: reward each person's own work — client handling, content
-- planning, and recorded activities.
--
-- Three new per-person bases beside 'entries' (₹ per cash-book row):
--   clients_handled — ₹ per client handled, or % of those clients' billing
--   planned         — ₹ per task planned, or % of its billing
--   activities      — ₹ per recorded item of chosen kinds (activity_kinds)
-- Like 'entries' they are measured per participant, so company scope only.
--
-- client_handlers records who handles each client, DATED: a handover closes
-- the old row the day before the new one starts, so past work stays credited
-- to whoever handled it then. At most one open row per client.
--
-- Safe in either order with the code: until this runs the new options fail
-- to save with a "run the migration" message, and nothing existing changes.

BEGIN;

ALTER TABLE public.ownership_programs DROP CONSTRAINT IF EXISTS ownership_programs_basis_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_basis_check
  CHECK (basis IN ('billing', 'collected', 'profit', 'fixed', 'entries', 'clients_handled', 'planned', 'activities'));

ALTER TABLE public.ownership_programs DROP CONSTRAINT IF EXISTS ownership_programs_entries_scope_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_entries_scope_check
  CHECK (basis NOT IN ('entries', 'clients_handled', 'planned', 'activities') OR scope_kind = 'company');

ALTER TABLE public.ownership_programs ADD COLUMN IF NOT EXISTS activity_kinds text[];
COMMENT ON COLUMN public.ownership_programs.activity_kinds IS
  'activities basis only: which recorded-work kinds count (src/lib/ownership/activity-kinds.ts).';

CREATE TABLE IF NOT EXISTS public.client_handlers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_by     uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_handlers_one_open
  ON public.client_handlers (client_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS client_handlers_employee ON public.client_handlers (employee_id);
COMMENT ON TABLE public.client_handlers IS
  'Who handles each client, dated. Read by Client handling ownership programs.';

-- Server-only (service role). Signed-in users may read; anon gets nothing.
ALTER TABLE public.client_handlers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_handlers FROM anon;
DROP POLICY IF EXISTS client_handlers_read ON public.client_handlers;
CREATE POLICY client_handlers_read ON public.client_handlers FOR SELECT TO authenticated USING (true);

COMMENT ON COLUMN public.ownership_awards.basis_amount_inr IS
  'What the award was measured on: rupees on a money basis; on a per-person basis (entries, clients_handled, planned, activities) a COUNT for a ₹ rule, or the person''s own rupees for a % rule.';

COMMIT;
