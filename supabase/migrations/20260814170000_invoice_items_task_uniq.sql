-- ═══════════════════════════════════════════════════════════════════════════
-- Give the invoice auto-attach upsert the arbiter index it has always assumed
--
-- SYMPTOM
--   Saving a task with a client and status "Done" fails with
--     there is no unique or exclusion constraint matching the ON CONFLICT
--     specification (42P10)
--   and no task is created. The same task saves at any other status, saves as
--   internal work (no client), and saves when it is linked to a package.
--   Flipping an existing client task to Done from the list fails identically —
--   that path uses the service role, which bypasses RLS but not a missing index.
--
-- CAUSE
--   trg_auto_attach_task → auto_attach_task_to_invoice() drafts the client's
--   monthly invoice line with
--     INSERT INTO invoice_items (...) ON CONFLICT (invoice_id, task_id) DO UPDATE
--   Arbiter inference runs at plan time and needs a unique index on exactly
--   (invoice_id, task_id). No migration in this repo has ever created one — it
--   existed only as a hand-made object in the live database, and went missing
--   during the Packages work (last billable task saved as Done: #1915,
--   12 Aug 2026 08:57 UTC; every task created after that is still `pending`).
--   The trigger is AFTER INSERT inside the caller's transaction, so its failure
--   rolls the task back too: the row is never written.
--
--   Only the Done branch upserts, which is why every other status is unaffected.
--
-- FIX
--   Create the index the function has assumed since 20260701120000, and commit
--   it this time so no environment can drift without it again.
--
--   NOT PARTIAL, deliberately. A predicate (`WHERE task_id IS NOT NULL`, or
--   anything package-related) makes the index un-inferrable for an unqualified
--   ON CONFLICT (invoice_id, task_id) and reproduces 42P10 exactly. If this
--   index ever needs narrowing, the trigger's ON CONFLICT clause has to carry
--   the matching predicate in the same change.
--
--   Fee lines carry task_id IS NULL (retainer, package). NULLs are distinct
--   under a default unique index, so any number of them coexist per invoice —
--   this does not constrain them.
--
-- SAFETY
--   Verified read-only before writing this: 1,867 lines carry a task_id, with
--   zero duplicate (invoice_id, task_id) pairs and no task on more than one
--   line, so the index builds without any cleanup. The guard below re-checks at
--   apply time and names the damage rather than failing on an opaque index
--   build, in case the data moved on.
--
-- Rollback: supabase/rollbacks/20260814170000_invoice_items_task_uniq_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE v_dupes INT;
BEGIN
  SELECT COUNT(*) INTO v_dupes FROM (
    SELECT invoice_id, task_id
      FROM public.invoice_items
     WHERE task_id IS NOT NULL
     GROUP BY invoice_id, task_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'invoice_items holds % duplicate (invoice_id, task_id) pair(s); the unique index cannot be built until each task has one line per invoice. List them with: SELECT invoice_id, task_id, COUNT(*) FROM invoice_items WHERE task_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1;',
      v_dupes;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_items_invoice_task_uniq
  ON public.invoice_items (invoice_id, task_id);

COMMENT ON INDEX public.invoice_items_invoice_task_uniq IS
  'Arbiter for auto_attach_task_to_invoice()''s ON CONFLICT (invoice_id, task_id). Must stay non-partial: a predicate makes it un-inferrable and every task saved as Done fails with 42P10. One invoice line per task per invoice; fee lines (task_id NULL) are unconstrained.';

COMMIT;
