-- ============================================================================
-- Remove the three dead agreements.* permission keys
-- ============================================================================
--
-- ⚠ THIS DOES NOT TOUCH ANY AGREEMENT DATA. Read that again before running.
--
--   client_agreements, agreement_items, agreement_item_services and every
--   agreement_* SQL function are LEFT ENTIRELY ALONE. They hold live rows and
--   are read by the Packages page, invoice building, contributions and the
--   partner statements. Dropping them would delete real records and break
--   those pages. This migration only deletes rows from `permissions`.
--
-- WHY THESE THREE KEYS GO
-- 20260722120000_client_agreements.sql seeded agreements.view,
-- agreements.manage and agreements.view_pricing, and nothing was ever wired to
-- read them:
--   • absent from src/lib/permissions/keys.ts (no PERMS.AGREEMENTS_* constant)
--   • no requirePermission / hasPermission / userCanSee call references them
--   • no route or nav entry is gated on them
-- Agreements surface through the Packages module, which gates on
-- packages.view / packages.manage instead.
--
-- So the toggles look like controls and change nothing. That is worse than
-- absent: an admin can grant "View Agreement Pricing" believing they have
-- given someone access, or revoke it believing they have taken it away, and in
-- both cases nothing happens. Removing them makes the permissions screen tell
-- the truth about what it can actually control.
--
-- The designation_permissions rows disappear with them via ON DELETE CASCADE
-- (see the FK in migration 001); the DELETE below is belt-and-braces in case a
-- deployment predates that constraint.
--
-- REVERSIBLE: re-running 20260722120000 re-inserts the three keys, since its
-- INSERT is ON CONFLICT DO NOTHING. Nothing here is destructive beyond three
-- catalogue rows nobody reads.
-- ============================================================================

BEGIN;

DELETE FROM public.designation_permissions
 WHERE permission_id IN (
   SELECT id FROM public.permissions
    WHERE key IN ('agreements.view', 'agreements.manage', 'agreements.view_pricing')
 );

DELETE FROM public.permissions
 WHERE key IN ('agreements.view', 'agreements.manage', 'agreements.view_pricing');

COMMIT;
