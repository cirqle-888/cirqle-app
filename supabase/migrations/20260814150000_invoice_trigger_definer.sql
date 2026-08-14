-- ═══════════════════════════════════════════════════════════════════════════
-- Invoice auto-attach must not depend on the TASK AUTHOR's billing rights
--
-- SYMPTOM
--   A non-admin employee adding a task with client + status "Done" gets
--     new row violates row-level security policy for table "invoice_items" (42501)
--   and the task is never created. The same task saves fine for an admin, and
--   fine for anyone at any other status.
--
-- CAUSE
--   The Add Task form inserts straight from the browser (anon key), so RLS
--   applies. `tasks_insert_perm` passes — every designation holds tasks.create.
--   But `trg_auto_attach_task` (AFTER INSERT on tasks) fires when the row is
--   billable-and-done, and auto_attach_task_to_invoice() is SECURITY INVOKER:
--   its INSERT into invoice_items, and find_or_create_client_month_draft()'s
--   INSERT into invoices, run as the employee. Those tables require
--   billing.edit / billing.view_invoices (migration 20260801090000), which no
--   non-admin designation has. The trigger aborts, taking the task with it.
--
--   Marking a task Done from the list never hit this: serverUpdateTaskStatus
--   goes through the admin client, and the service role bypasses RLS.
--
-- FIX
--   Drafting the client's monthly invoice is a system derivation, not an act
--   the task author performs — it should not be gated on their permissions.
--   Run the trigger function with definer rights so the nested writes execute
--   as the function owner. Nested calls (find_or_create_client_month_draft,
--   recalc_invoice_totals) inherit that context, so only the trigger entry
--   point changes; neither becomes independently callable, because a function
--   returning `trigger` cannot be invoked over PostgREST.
--
--   ALTER FUNCTION, not CREATE OR REPLACE: the body stays exactly as deployed.
--
-- SECURITY NOTE
--   This does not widen what an employee may bill. It only lets the invoice a
--   task implies be drafted. Every user-facing invoice read/write still goes
--   through the unchanged invoices / invoice_items policies.
--
-- Rollback:
--   ALTER FUNCTION public.auto_attach_task_to_invoice() SECURITY INVOKER;
--   ALTER FUNCTION public.auto_attach_task_to_invoice() RESET search_path;
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER FUNCTION public.auto_attach_task_to_invoice()
  SECURITY DEFINER
  SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.auto_attach_task_to_invoice() IS
  'Keeps a client task''s draft invoice line in sync. SECURITY DEFINER: invoice drafting is a system derivation and must not require the task author to hold billing.edit.';

COMMIT;
