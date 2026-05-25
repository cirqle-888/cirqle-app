-- ============================================================
-- CIRQLE Migration 008 — Promote is_master and input_type to DB columns
-- ============================================================
--
-- Context:
--   Both `is_master` and `input_type` have been live in the TypeScript types
--   and Settings UI for some time, but were persisted only in localStorage
--   (key: cirqle_param_meta) because the DB columns didn't exist yet.
--
--   This migration promotes them to first-class DB columns so:
--     1. is_master can be used in server-side analytics queries
--     2. input_type drives correct UX in contributions modal server-side
--     3. localStorage fallback in settings-client.tsx can be removed
--
-- Backfill heuristic:
--   Parameters with weight = 1 are the clear master candidates in every
--   existing group (Products → Variable Group, Design → Design Group).
--   All others default to sub-parameter / count mode.
--
-- Safe to run on a live database:
--   ADD COLUMN IF NOT EXISTS with a DEFAULT never locks.
--   UPDATE with WHERE is a targeted row scan.
--   CREATE UNIQUE INDEX ... WHERE allows multiple non-masters per group.
-- ============================================================

-- ── 1. Add columns ────────────────────────────────────────────────────────────

ALTER TABLE parameters
  ADD COLUMN IF NOT EXISTS is_master   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS input_type  TEXT    NOT NULL DEFAULT 'count';

-- ── 2. Backfill — weight = 1 → master + percentage input ──────────────────────
-- These are the natural anchors of each group (Design, Products).
-- All other parameters keep is_master = false, input_type = 'count'.

UPDATE parameters
SET  is_master  = true,
     input_type = 'percentage'
WHERE weight = 1
  AND is_active = true;

-- Sub-parameters that were already count-mode (weight < 1) keep input_type = 'count'.
-- The DEFAULT handles new rows; no extra UPDATE needed.

-- ── 3. Enforce one master per group ──────────────────────────────────────────
-- Partial unique index: only one row per group_id may have is_master = true.
-- Non-master rows are unconstrained.

CREATE UNIQUE INDEX IF NOT EXISTS idx_parameters_one_master_per_group
  ON parameters (group_id)
  WHERE is_master = true;

-- ── 4. Add check constraint on input_type values ─────────────────────────────

ALTER TABLE parameters
  DROP CONSTRAINT IF EXISTS parameters_input_type_check;

ALTER TABLE parameters
  ADD CONSTRAINT parameters_input_type_check
  CHECK (input_type IN ('count', 'percentage'));

-- ── Verify (informational) ────────────────────────────────────────────────────
-- SELECT g.name AS group_name, p.name AS param_name, p.is_master, p.input_type, p.weight
-- FROM   parameters p
-- JOIN   contribution_groups g ON g.id = p.group_id
-- WHERE  p.is_active = true
-- ORDER  BY g.name, p.is_master DESC, p.weight DESC;
