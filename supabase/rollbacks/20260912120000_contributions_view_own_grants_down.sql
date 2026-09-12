-- Rollback for 20260912120000_contributions_view_own_grants.
--
-- Returns both designations to allowed = FALSE rather than deleting the rows,
-- so the Access & Roles screen keeps showing the toggle as a deliberate "off"
-- instead of an unreviewed gap.
--
-- Revert the application code first, or these two roles lose the Contributions
-- page entirely: the nav item, the route and the page now require one of
-- view_own / view_unit / view_all, and neither designation holds the others.

BEGIN;

UPDATE designation_permissions dp
   SET allowed = FALSE
  FROM designations d, permissions p
 WHERE dp.designation_id = d.id
   AND dp.permission_id = p.id
   AND p.key = 'contributions.view_own'
   AND d.name IN ('Designer', 'Client Success & Social Media Executive');

COMMIT;
