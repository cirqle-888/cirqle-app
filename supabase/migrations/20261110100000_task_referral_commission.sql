-- Referral commission: pay a staff member a % of a job that came through them.
--
-- The job carries it, not a program:
--   tasks.referred_by       — the employee the work came through
--   tasks.referral_percent  — their share of THAT job's billing
--
-- Paid by one built-in ownership program, basis 'referrals', seeded below.
-- It is the ordinary award machinery — so the commission books into the
-- payroll month of the job's date, itemised on the payslip, frozen once that
-- month is paid or locked — but nobody configures a rule per job: whoever is
-- named on a task is paid that task's %. Switching the program off in
-- Settings → Ownership stops every referral payment at once.
--
-- Safe in either order with the code: until this runs, the task editor hides
-- the Referred by fields and the engine has no referral program to run.

BEGIN;

-- ── 1. The job's referral ────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_percent numeric(6,2);

-- Both or neither: a name with no % pays nothing and reads like a mistake;
-- a % with no name pays no one. 0 < % ≤ 100.
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_referral_shape;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_referral_shape CHECK (
  (referred_by IS NULL AND referral_percent IS NULL)
  OR (referred_by IS NOT NULL AND referral_percent > 0 AND referral_percent <= 100)
);

-- The engine reads "this month's referred jobs"; keep that a tiny index scan.
CREATE INDEX IF NOT EXISTS tasks_referred_by_idx
  ON public.tasks (referred_by, task_date) WHERE referred_by IS NOT NULL;

COMMENT ON COLUMN public.tasks.referred_by IS
  'Staff member this job came through. Paid referral_percent of the job''s billing by the built-in "Referral commission" ownership program.';
COMMENT ON COLUMN public.tasks.referral_percent IS
  'Referrer''s share of this job''s billing (billing_amount_inr), 0–100. Booked into the payroll month of task_date.';

-- ── 2. The basis ────────────────────────────────────────────────────────
ALTER TABLE public.ownership_programs DROP CONSTRAINT IF EXISTS ownership_programs_basis_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_basis_check
  CHECK (basis IN ('billing', 'collected', 'profit', 'fixed', 'entries', 'clients_handled', 'planned', 'activities', 'referrals'));

ALTER TABLE public.ownership_programs DROP CONSTRAINT IF EXISTS ownership_programs_entries_scope_check;
ALTER TABLE public.ownership_programs
  ADD CONSTRAINT ownership_programs_entries_scope_check
  CHECK (basis NOT IN ('entries', 'clients_handled', 'planned', 'activities', 'referrals') OR scope_kind = 'company');

-- ── 3. The one program that pays it ─────────────────────────────────────
-- Awards reference a program AND a rule, so both must exist. The rule's
-- target is never consulted for this basis — the jobs themselves say who is
-- paid — but the table requires one, so it names the admin designation.
-- Its 100% reads as "the % set on each job, in full".
DO $$
DECLARE
  prog_id  uuid;
  admin_ds uuid;
BEGIN
  SELECT id INTO prog_id FROM public.ownership_programs WHERE basis = 'referrals' ORDER BY created_at LIMIT 1;
  IF prog_id IS NULL THEN
    INSERT INTO public.ownership_programs
      (name, program_type, basis, period_type, scope_kind, scope_id, effective_from, is_active)
    VALUES
      ('Referral commission', 'referral', 'referrals', 'monthly', 'company', NULL, DATE '2026-01-01', true)
    RETURNING id INTO prog_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ownership_rules WHERE program_id = prog_id) THEN
    SELECT id INTO admin_ds FROM public.designations WHERE is_admin = true ORDER BY created_at NULLS LAST, id LIMIT 1;
    IF admin_ds IS NOT NULL THEN
      INSERT INTO public.ownership_rules
        (program_id, designation_id, percent, label, effective_from, is_active)
      VALUES
        (prog_id, admin_ds, 100, 'Whoever is named on the job', DATE '2026-01-01', true);
    END IF;
  END IF;
END $$;

COMMIT;
