-- Offer campaign lifecycle timestamps, to support the weekly-offer workflow:
--   • completed_at — when a campaign was finalised (last week's offer is "done").
--     Used by the auto-archive job to age finalised campaigns out of the inbox.
--   • archived_at  — when the auto-archive job (or an admin) archived it.
-- Both are nullable and additive: existing rows/data are untouched, and the
-- frozen Google Sheet column contract is unaffected (these are internal only).

BEGIN;

ALTER TABLE offer_campaigns ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE offer_campaigns ADD COLUMN IF NOT EXISTS archived_at  timestamptz;

-- Backfill a reasonable completed_at for already-finalised campaigns so the
-- auto-archive job has a timestamp to age from (best-effort: uses updated_at).
UPDATE offer_campaigns
  SET completed_at = updated_at
  WHERE status = 'finalised' AND completed_at IS NULL;

UPDATE offer_campaigns
  SET archived_at = updated_at
  WHERE status = 'archived' AND archived_at IS NULL;

COMMIT;
