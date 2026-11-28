-- Reverses 20261128140000_unit_kind_branch.sql. Any branch becomes a
-- department first, so the narrower check can be put back.
BEGIN;
UPDATE public.business_units SET kind = 'department' WHERE kind = 'branch';
ALTER TABLE public.business_units DROP CONSTRAINT IF EXISTS business_units_kind_check;
ALTER TABLE public.business_units
  ADD CONSTRAINT business_units_kind_check CHECK (kind IN ('department', 'brand'));
NOTIFY pgrst, 'reload schema';
COMMIT;
