-- ============================================================================
-- Grant tasks.delete to the designation CQID002 holds
-- ============================================================================
-- Additive, idempotent, INSERT-only. Safe to re-run.
--
-- WHY
-- Moving a task to Trash (soft delete) requires the `tasks.delete` permission
-- (serverDeleteTask / serverBulkDeleteTasks → requirePermission(TASKS_DELETE),
-- enforced through the service-role client, so this grant is the only gate).
-- Out of the box only Admin and "Task Manager + Collections" hold it: the
-- preset roles seeded in migration 005 got tasks.create / edit / assign but
-- never tasks.delete. CQID002's role is a non-admin designation that was never
-- granted the key, so every delete came back "Permission denied."
--
-- Reported: CQID002 cannot delete tasks.
--
-- SCOPE
-- Keyed off the EMPLOYEE row rather than a hard-coded designation name, so it
-- grants to whatever designation CQID002 currently holds — no guessing the
-- name. Permissions are per-designation, so this applies to everyone sharing
-- that role (intended). It does NOT grant tasks.trash — restoring, emptying
-- Trash and permanent delete stay a separate capability; grant tasks.trash as
-- well if that role should manage the Trash too.
-- ============================================================================

BEGIN;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT e.designation_id, p.id, TRUE
  FROM public.employees  e
  JOIN public.permissions p ON p.key = 'tasks.delete'
 WHERE e.cqid = 'CQID002'
   AND e.designation_id IS NOT NULL
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
