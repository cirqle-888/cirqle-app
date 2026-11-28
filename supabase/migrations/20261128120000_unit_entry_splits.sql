-- ============================================================================
-- Cash Book entries split across units
-- ============================================================================
-- Additive and idempotent. Needs 20261127100000_business_units.
--
-- Until now a company Cash Book entry could belong to ONE unit, be General
-- (split equally between the units that carry general costs), or be left out.
-- Some costs are shared unevenly — an iPad used 50 % by Social Media, 30 % by
-- Cirqle Flyers and 20 % by Memoura. This table holds such a split: one row per
-- unit with its share, entered as a percentage or as an amount (only the
-- proportions are used; the app checks percentages add up to 100 and amounts to
-- the entry's amount).
--
-- A split wins over any tag in business_unit_entries; the app keeps the two
-- exclusive. Nothing here edits the Cash Book entry itself.
--
-- Server-only: RLS on, no browser grants.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.business_unit_entry_splits (
  entry_id    UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,
  unit_id     UUID NOT NULL REFERENCES public.business_units(id) ON DELETE CASCADE,
  share       NUMERIC(14,4) NOT NULL CHECK (share > 0),
  -- How the share was entered, so the form shows it back the same way.
  basis       TEXT NOT NULL DEFAULT 'percent' CHECK (basis IN ('percent', 'amount')),
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, unit_id)
);
CREATE INDEX IF NOT EXISTS business_unit_entry_splits_unit_idx ON public.business_unit_entry_splits (unit_id);

ALTER TABLE public.business_unit_entry_splits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_unit_entry_splits FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
