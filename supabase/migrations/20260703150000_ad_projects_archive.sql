-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Advertising — campaign archiving                                         ║
-- ║                                                                            ║
-- ║  Stopped/finished campaigns can be archived: they disappear from the      ║
-- ║  Advertising dashboard (a collapsed "Archived" section keeps them one     ║
-- ║  click away), stop syncing, and stop producing alerts — but nothing is    ║
-- ║  deleted: metrics, wallet ledger rows, the task and invoices all remain,  ║
-- ║  and Unarchive restores the campaign exactly as it was.                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

ALTER TABLE public.ad_projects
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Dashboard lists filter on "live" campaigns; keep that path fast.
CREATE INDEX IF NOT EXISTS ad_projects_live_idx
  ON public.ad_projects (created_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

COMMIT;
