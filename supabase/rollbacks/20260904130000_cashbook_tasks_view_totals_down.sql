-- Rollback for 20260904130000_cashbook_tasks_view_totals.
--
-- Removing the permission rows cascades to their designation_permissions rows
-- (FK), so a single DELETE undoes the whole migration. Every designation goes
-- back to having no opinion on "totals" specifically — the app code falls
-- back to userCanSee() returning false for a key that no longer exists in
-- anyone's permission set, which is the same as "not granted" it started as.
--
-- NOTE: if the application code has already been deployed expecting these
-- keys (gating the Cash Book summary / Accounts tab / Tasks day-totals on
-- them), rolling back the DATA without also reverting the CODE will hide
-- those surfaces from everyone except admins. Revert the code first.

BEGIN;

DELETE FROM permissions WHERE key IN ('cashbook.view_totals', 'tasks.view_totals');

COMMIT;
