-- Drop the DEFAULT 0 on client_service_pricing.commission_percentage.
--
-- WHY THIS IS A MONEY BUG, not a tidy-up:
--
-- Several write paths deliberately OMIT commission_percentage from their
-- upsert payload so that `ON CONFLICT DO UPDATE` leaves an agreed rate
-- untouched when a price is edited. That reasoning is correct for the UPDATE
-- branch and WRONG for the INSERT branch: when the pair has no row yet, the
-- upsert inserts and the omitted column takes its DEFAULT — which is 0.
--
-- 0 is not "unset". Every reader resolves commission with `?? 50` or
-- `!= null`, and neither guard catches 0, so the pool becomes
-- `billing * 0/100` = 0 and every contributor on every task for that pair
-- earns nothing. NULL, by contrast, is byte-identical to having no row at all
-- at every resolver.
--
-- Two rows in production already carry commission_percentage = 0 from exactly
-- this path (both currently have zero tasks, so no money is presently wrong).
--
-- With the DEFAULT dropped, an omitted column inserts NULL — which is the
-- semantics every one of those call sites already believes it has. This fixes
-- all current paths and any future one, without touching application code.
--
-- Existing rows are NOT modified: the two 0-commission rows are left as-is,
-- because a 0 that someone may have entered deliberately is not ours to
-- reinterpret. Review them by hand:
--   SELECT * FROM client_service_pricing WHERE commission_percentage = 0;

ALTER TABLE client_service_pricing
  ALTER COLUMN commission_percentage DROP DEFAULT;
