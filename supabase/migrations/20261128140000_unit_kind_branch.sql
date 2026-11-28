-- ============================================================================
-- Business units can be branches too
-- ============================================================================
-- Idempotent. Needs 20261127100000_business_units.
--
-- Cirqle is the umbrella; under it sit departments, sub-brands and now
-- BRANCHES (a second office or city). A branch works exactly like the other
-- kinds — its own team, work, Cash Book and optional agreement; the kind only
-- decides how the unit is named and grouped.
-- ============================================================================

BEGIN;

ALTER TABLE public.business_units DROP CONSTRAINT IF EXISTS business_units_kind_check;
ALTER TABLE public.business_units
  ADD CONSTRAINT business_units_kind_check CHECK (kind IN ('department', 'brand', 'branch'));

NOTIFY pgrst, 'reload schema';

COMMIT;
