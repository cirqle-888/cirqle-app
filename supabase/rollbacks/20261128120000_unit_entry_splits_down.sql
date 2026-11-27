-- Reverses 20261128120000_unit_entry_splits.sql. Deletes every split; those
-- Cash Book entries go back to "waiting" (or their automatic rule) in the unit
-- results. The entries themselves are untouched.
BEGIN;
DROP TABLE IF EXISTS public.business_unit_entry_splits;
NOTIFY pgrst, 'reload schema';
COMMIT;
