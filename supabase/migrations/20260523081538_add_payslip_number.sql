-- Add payslip_number column to payroll table
-- Format: PAY-YYYY-NNNN (e.g. PAY-2025-0042)

BEGIN;

-- 1. Add the column (nullable first, we'll backfill then constrain)
ALTER TABLE public.payroll
  ADD COLUMN IF NOT EXISTS payslip_number TEXT;

-- 2. Create a sequence for the global counter (shared across all years)
CREATE SEQUENCE IF NOT EXISTS payslip_number_seq START 1;

-- 3. Backfill existing rows ordered by year/month so numbers are chronological
WITH ordered AS (
  SELECT id,
         year,
         month,
         ROW_NUMBER() OVER (ORDER BY year ASC, month ASC, created_at ASC) AS rn
  FROM public.payroll
  WHERE payslip_number IS NULL
)
UPDATE public.payroll p
SET payslip_number = 'PAY-' || o.year || '-' || LPAD(o.rn::TEXT, 4, '0')
FROM ordered o
WHERE p.id = o.id;

-- 4. Auto-assign payslip_number on INSERT via trigger
CREATE OR REPLACE FUNCTION assign_payslip_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_seq BIGINT;
BEGIN
  IF NEW.payslip_number IS NULL THEN
    -- Use a per-year counter: count existing slips for that year + 1
    SELECT COALESCE(MAX(
      CASE WHEN payslip_number ~ ('^PAY-' || NEW.year || '-[0-9]+$')
           THEN CAST(SPLIT_PART(payslip_number, '-', 3) AS INT)
           ELSE 0 END
    ), 0) + 1
    INTO next_seq
    FROM public.payroll
    WHERE year = NEW.year AND payslip_number IS NOT NULL;

    NEW.payslip_number := 'PAY-' || NEW.year || '-' || LPAD(next_seq::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_assign_payslip_number ON public.payroll;
CREATE TRIGGER trigger_assign_payslip_number
  BEFORE INSERT ON public.payroll
  FOR EACH ROW
  EXECUTE FUNCTION assign_payslip_number();

-- 5. Add unique constraint
ALTER TABLE public.payroll
  ADD CONSTRAINT payroll_payslip_number_unique UNIQUE (payslip_number);

COMMIT;
