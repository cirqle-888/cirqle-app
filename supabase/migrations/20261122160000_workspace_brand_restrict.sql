-- ============================================================================
-- A brand workspace can CONFINE its members to the brand
-- ============================================================================
-- Additive and idempotent. Builds on 20261122140000_workspace_brand.
--
-- workspaces.brand_id makes a workspace SHOW one brand. restrict_members goes
-- further: every non-admin member of the workspace is confined to that brand
-- everywhere — the same service/department scoping "Restrict to assigned
-- services" uses, with the brand's services as the assignment — and cannot
-- switch to another brand. Admins are never confined.
-- ============================================================================

BEGIN;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS restrict_members BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN public.workspaces.restrict_members IS
  'With brand_id set: confine non-admin members to that brand everywhere (scoping, not just the view).';

NOTIFY pgrst, 'reload schema';

COMMIT;
