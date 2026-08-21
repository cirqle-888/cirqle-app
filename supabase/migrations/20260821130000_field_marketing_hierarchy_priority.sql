-- ============================================================================
-- Field Marketing — hierarchy + priority (Phase 1 schema)
-- ============================================================================
-- Additive, idempotent, NON-DESTRUCTIVE. Preserves all existing field_* data
-- (the 31 seeded places, contacts, visits). Two independent changes:
--
--   1. field_places.priority — a first-class A/B/C priority (was only inside
--      notes text). Drives Next Best Visit / On The Way / Plan My Day scoring.
--
--   2. field_territories gains a self-referential hierarchy so the flat
--      territory table can express Region → Area → Locality → Route without a
--      new table or duplicated data. A place's existing territory_id points at
--      a `locality`; ancestors are found by walking parent_id.
--
-- Data population (backfill priority from notes, seed the Bengaluru tree, and
-- assign the 31 places to localities) is done AFTER this by an idempotent
-- service-role script — this migration is pure DDL so it is safe to run in the
-- Supabase SQL editor.
-- ============================================================================

BEGIN;

-- 1. Priority on places (A = high, B = medium, C = low). Nullable = unset.
ALTER TABLE public.field_places
  ADD COLUMN IF NOT EXISTS priority TEXT CHECK (priority IN ('A','B','C'));

CREATE INDEX IF NOT EXISTS field_places_priority_idx
  ON public.field_places (priority) WHERE priority IS NOT NULL;

-- 2. Hierarchy on the existing territory table.
ALTER TABLE public.field_territories
  ADD COLUMN IF NOT EXISTS parent_id UUID
    REFERENCES public.field_territories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'area'
    CHECK (kind IN ('region','area','locality','route'));

CREATE INDEX IF NOT EXISTS field_territories_parent_idx
  ON public.field_territories (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS field_territories_kind_idx
  ON public.field_territories (kind);

-- Idempotent seeding key: one territory per (name, kind, parent). parent_id is
-- NULL for top-level regions, so COALESCE it to a sentinel for the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS field_territories_name_kind_parent_uniq
  ON public.field_territories
     (lower(name), kind, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMIT;
