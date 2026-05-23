-- Update payslip_number format to PAY-{CQID_DIGITS}-{MMYY}
-- Example: CQID002, May 2026 → PAY-002-0526

BEGIN;

-- 1. Drop the old unique constraint (we'll re-add after backfill)
ALTER TABLE public.payroll
  DROP CONSTRAINT IF EXISTS payroll_payslip_number_unique;

-- 2. Backfill all existing rows with new format
--    Format: PAY-{numeric part of cqid}-{MM}{YY}
UPDATE public.payroll p
SET payslip_number =
  'PAY-' ||
  REGEXP_REPLACE(e.cqid, '[^0-9]', '', 'g') ||
  '-' ||
  LPAD(p.month::TEXT, 2, '0') ||
  RIGHT(p.year::TEXT, 2)
FROM public.employees e
WHERE p.employee_id = e.id;

-- 3. Replace the trigger function with the new format logic
CREATE OR REPLACE FUNCTION assign_payslip_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  emp_cqid TEXT;
  emp_num  TEXT;
BEGIN
  IF NEW.payslip_number IS NULL THEN
    -- Fetch employee CQID
    SELECT cqid INTO emp_cqid
    FROM public.employees
    WHERE id = NEW.employee_id;

    -- Extract only digits from CQID  (e.g. "CQID002" → "002")
    emp_num := REGEXP_REPLACE(emp_cqid, '[^0-9]', '', 'g');

    -- Build: PAY-{emp_num}-{MM}{YY}
    NEW.payslip_number :=
      'PAY-' ||
      emp_num ||
      '-' ||
      LPAD(NEW.month::TEXT, 2, '0') ||
      RIGHT(NEW.year::TEXT, 2);
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger already exists from previous migration, just replacing function body above.
-- Ensure trigger is attached (idempotent):
DROP TRIGGER IF EXISTS trigger_assign_payslip_number ON public.payroll;
CREATE TRIGGER trigger_assign_payslip_number
  BEFORE INSERT ON public.payroll
  FOR EACH ROW
  EXECUTE FUNCTION assign_payslip_number();

-- 4. Re-add unique constraint
ALTER TABLE public.payroll
  ADD CONSTRAINT payroll_payslip_number_unique UNIQUE (payslip_number);

COMMIT;
