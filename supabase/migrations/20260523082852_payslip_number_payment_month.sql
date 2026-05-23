-- Update payslip_number to use PAYMENT month (salary month + 1)
-- Logic: Aug 2023 salary → paid Sep 2023 → PAY-001-0923 — Aug 2023
-- Dec 2024 salary → paid Jan 2025 → PAY-001-0125 — Dec 2024

BEGIN;

-- 1. Drop unique constraint temporarily
ALTER TABLE public.payroll
  DROP CONSTRAINT IF EXISTS payroll_payslip_number_unique;

-- 2. Backfill all existing rows using payment month (salary month + 1)
UPDATE public.payroll p
SET payslip_number =
  'PAY-' ||
  REGEXP_REPLACE(e.cqid, '[^0-9]', '', 'g') ||
  '-' ||
  -- Payment month = salary month + 1, wrapping Dec → Jan
  LPAD(
    CASE WHEN p.month = 12 THEN 1 ELSE p.month + 1 END::TEXT,
    2, '0'
  ) ||
  -- Payment year = salary year + 1 if December, else same year
  RIGHT(
    CASE WHEN p.month = 12 THEN (p.year + 1) ELSE p.year END::TEXT,
    2
  )
FROM public.employees e
WHERE p.employee_id = e.id;

-- 3. Update trigger to use payment month
CREATE OR REPLACE FUNCTION assign_payslip_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  emp_cqid     TEXT;
  emp_num      TEXT;
  pay_month    INT;
  pay_year     INT;
BEGIN
  IF NEW.payslip_number IS NULL THEN
    -- Fetch employee CQID
    SELECT cqid INTO emp_cqid
    FROM public.employees
    WHERE id = NEW.employee_id;

    -- Extract digits from CQID (e.g. "CQID002" → "002")
    emp_num := REGEXP_REPLACE(emp_cqid, '[^0-9]', '', 'g');

    -- Payment month = salary month + 1 (with December rollover)
    IF NEW.month = 12 THEN
      pay_month := 1;
      pay_year  := NEW.year + 1;
    ELSE
      pay_month := NEW.month + 1;
      pay_year  := NEW.year;
    END IF;

    -- Build: PAY-{emp_num}-{MM}{YY}  (MM/YY = payment month/year)
    NEW.payslip_number :=
      'PAY-' ||
      emp_num ||
      '-' ||
      LPAD(pay_month::TEXT, 2, '0') ||
      RIGHT(pay_year::TEXT, 2);
  END IF;
  RETURN NEW;
END;
$$;

-- Re-attach trigger (idempotent)
DROP TRIGGER IF EXISTS trigger_assign_payslip_number ON public.payroll;
CREATE TRIGGER trigger_assign_payslip_number
  BEFORE INSERT ON public.payroll
  FOR EACH ROW
  EXECUTE FUNCTION assign_payslip_number();

-- 4. Restore unique constraint
ALTER TABLE public.payroll
  ADD CONSTRAINT payroll_payslip_number_unique UNIQUE (payslip_number);

COMMIT;
