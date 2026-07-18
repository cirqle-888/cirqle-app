-- Fix: cancelCampaign() writes status='cancelled', but the original
-- offer_campaigns CHECK only allowed ('active','finalised','archived'), so the
-- update silently failed and clients could never cancel an offer request.
-- Widen the constraint to include 'cancelled'.

BEGIN;

ALTER TABLE offer_campaigns
  DROP CONSTRAINT IF EXISTS offer_campaigns_status_check;

ALTER TABLE offer_campaigns
  ADD CONSTRAINT offer_campaigns_status_check
  CHECK (status IN ('active', 'finalised', 'archived', 'cancelled'));

COMMIT;
