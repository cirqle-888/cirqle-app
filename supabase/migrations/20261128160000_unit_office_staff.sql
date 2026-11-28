-- ============================================================================
-- Cirqle's office team
-- ============================================================================
-- Additive and idempotent. Needs 20261127100000_business_units.
--
-- Cirqle is the parent over its departments, branches and sub-brands. Some
-- people work for the parent itself — accounts, admin, client success — not
-- for one unit. This table is the owner's list of those people (Departments &
-- Brands → Cirqle HQ → Office team).
--
-- It grants nothing by itself. What each person can open stays on their role
-- (designations / designation_permissions), the set the app and the database
-- already enforce; the Office team page edits it per person. Unit views keep
-- office staff confidential (one line under the owner).
--
-- Server-only: RLS on, no browser grants.
-- Undo: rollbacks/20261128160000_unit_office_staff_down.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.business_unit_office_staff (
  employee_id UUID PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  added_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.business_unit_office_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_unit_office_staff FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
