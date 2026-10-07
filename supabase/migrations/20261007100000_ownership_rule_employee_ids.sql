-- Ownership rules can name several employees
--
-- One rule ("₹5 per task entered") for CQID002 and CQID003 used to need two
-- identical rules. `employee_ids` lets one rule list several people; each is
-- still measured and paid on their own work, exactly as with separate rules.
--
-- A rule targets exactly one of: one employee (employee_id), several
-- employees (employee_ids), or a designation (designation_id). The original
-- anonymous CHECK allowed only the first and last, so it is replaced by a
-- named one that allows all three.
--
-- Safe in either order with the code: until this runs, picking more than one
-- employee fails to save with a "run the migration" message; single-employee
-- and designation rules are unaffected.

BEGIN;

ALTER TABLE public.ownership_rules ADD COLUMN IF NOT EXISTS employee_ids uuid[];
COMMENT ON COLUMN public.ownership_rules.employee_ids IS
  'Several named employees, each paid on their own work. Set instead of employee_id / designation_id.';

-- Drop the original unnamed "(employee_id IS NULL) <> (designation_id IS NULL)" check.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.ownership_rules'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%employee_id IS NULL%designation_id IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.ownership_rules DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.ownership_rules DROP CONSTRAINT IF EXISTS ownership_rules_one_target;
ALTER TABLE public.ownership_rules ADD CONSTRAINT ownership_rules_one_target CHECK (
  (employee_id IS NOT NULL)::int
  + (designation_id IS NOT NULL)::int
  + (COALESCE(cardinality(employee_ids), 0) > 0)::int = 1
);

COMMIT;
