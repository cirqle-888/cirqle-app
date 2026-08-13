-- An opening cycle that is longer than one month.
--
-- A retainer signed on 20 July is not worth a full month's fee for eleven days.
-- The usual answer is to run the first cycle to the end of the FOLLOWING month —
-- 20 Jul → 31 Aug — bill it once, and start normal calendar months after that.
--
-- Optional by design: leave it NULL and the package bills every calendar month
-- exactly as before. It only ever affects the opening span; nothing downstream
-- changes.
--
-- Two things follow from it, both handled in lib/packages/progress.ts:
--   • the fee bills ONCE for the whole span, on the invoice of the starting month
--   • the included allowance covers the whole span too (15 posts across Jul+Aug,
--     not 15 in July and another 15 in August)

BEGIN;

ALTER TABLE public.client_packages
  ADD COLUMN IF NOT EXISTS first_cycle_end DATE;

COMMENT ON COLUMN public.client_packages.first_cycle_end IS
  'Optional. Monthly packages only. The opening cycle runs from start_date to the END OF THE MONTH containing this date, bills once, and carries one allowance. NULL = bill every calendar month from the start.';

-- The opening cycle cannot end before the package begins.
ALTER TABLE public.client_packages
  DROP CONSTRAINT IF EXISTS client_packages_first_cycle_after_start;
ALTER TABLE public.client_packages
  ADD CONSTRAINT client_packages_first_cycle_after_start
  CHECK (first_cycle_end IS NULL OR first_cycle_end >= start_date);

COMMIT;
