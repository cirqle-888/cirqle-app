-- Remove offer.manage_groups ("Manage offer categories")
--
-- Left out of 20261003200000_prune_inert_permissions pending a decision: it
-- was granted to Flyer Designer by hand, but nothing in the app checks it —
-- the offer-category settings are admin-only (they show the Apps Script
-- shared secret). Offer flyers are now produced in a separate app, so the
-- switch will not be wired up; it is removed like the other five.

BEGIN;

DELETE FROM public.designation_permissions
 WHERE permission_id IN (SELECT id FROM public.permissions WHERE key = 'offer.manage_groups');

DELETE FROM public.permissions WHERE key = 'offer.manage_groups';

COMMIT;
