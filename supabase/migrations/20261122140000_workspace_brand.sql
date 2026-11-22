-- ============================================================================
-- A workspace can belong to a brand
-- ============================================================================
-- Additive and idempotent. Safe to re-run. Builds on 20261122100000_brands.
--
-- A workspace decides WHICH MENUS show; a brand lens decides WHICH DATA shows
-- (Tasks, Clients narrowed to one brand). Tying the two lets a "Memoura"
-- workspace be a complete Memoura view: switch into it and the sidebar, the
-- landing page and the lists are all Memoura. Members assigned to it live in
-- it, so the Memoura team always works in Memoura.
--
-- Still a VIEW, never a permission: it only narrows. Hard restriction stays on
-- the role ("Restrict to assigned services") plus the person's brand.
-- NULL = no brand: the workspace shows every brand, as before.
-- ============================================================================

BEGIN;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.workspaces.brand_id IS
  'The Cirqle brand this workspace shows (Tasks, Clients narrowed to it). NULL = all brands.';

NOTIFY pgrst, 'reload schema';

COMMIT;
