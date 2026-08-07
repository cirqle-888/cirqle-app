-- ═══════════════════════════════════════════════════════════════════════════
-- DERIVED BILLING RULES — bill a task as a % of OTHER tasks' billing.
--
-- The case: "Social Media Handling" is charged at 30% of everything billed for
-- Social Media Poster / Stories / Reels that month. Today the only derived
-- billing is the single-parent VARIANT (percent_of_parent), which is frozen at
-- creation and reads exactly one parent — no way to bill off a whole group,
-- and no recompute when the sources move.
--
-- Model:
--   tasks.billing_mode = 'percent_of_services'  (new CHECK member)
--   tasks.billing_rule JSONB                    the whole rule, versioned
--
-- The rule is ONE JSONB document rather than a spread of columns, because the
-- roadmap is explicitly "more billing methods later" (fixed, percent+fixed,
-- min/max, tiers, formulas). Those become new cases in one pure interpreter —
-- a schema migration per method is exactly the redesign this shape avoids.
-- Shape (v1):
--   { v:1, method:'percent', percent:30,
--     sources:{serviceIds:[...]},
--     filters:{statusNotIn:[...]}, clamps:{minInr,maxInr},
--     override:{amount,note,at,by}|null, paused?:bool, archivedAt?:ts }
--
-- INVARIANT (load-bearing): a derived task's basis NEVER includes another
-- derived task. The graph is single-level, so cycles are structurally
-- impossible, many rules can read the same sources independently, and any
-- recompute is a pure function of non-derived rows.
--
-- Rollback: supabase/rollbacks/20260808110000_derived_billing_rules_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Allow the new billing_mode ────────────────────────────────────────────
-- The constraint's name differs between environments (002 created it inline),
-- so find it by definition rather than guessing a name.
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'public.tasks'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%billing_mode%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.tasks DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_billing_mode_check
  CHECK (billing_mode IN ('fixed', 'percent_of_parent', 'parameter_driven', 'percent_of_services'));

-- ── 2. The rule ──────────────────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS billing_rule JSONB;

COMMENT ON COLUMN public.tasks.billing_rule IS
  'Derived-billing rule (billing_mode=percent_of_services). Versioned JSON: {v,method,percent,sources,filters,clamps,override,paused,archivedAt}. Interpreted by src/lib/tasks/derived-billing.ts.';

-- Fan-in: "which derived tasks read service X?" — asked on every source task
-- write, so it must not be a sequential scan.
CREATE INDEX IF NOT EXISTS idx_tasks_derived_source_services
  ON public.tasks USING GIN ((billing_rule -> 'sources' -> 'serviceIds'))
  WHERE billing_mode = 'percent_of_services' AND deleted_at IS NULL;

-- ── 3. Integrity ─────────────────────────────────────────────────────────────
-- A derived task is not a variant: variants read one frozen parent, derived
-- tasks read a live rule. Allowing both would leave two engines fighting over
-- one amount.
ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_derived_not_variant;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_derived_not_variant
  CHECK (billing_mode <> 'percent_of_services' OR parent_task_id IS NULL);

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_derived_has_rule;
ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_derived_has_rule
  CHECK (billing_mode <> 'percent_of_services' OR billing_rule IS NOT NULL);

-- ── 4. Reusable rule templates ───────────────────────────────────────────────
-- Deliberately client-free: a template is a rule SHAPE ("Handling 30% of
-- posters"), so one row serves every client. Archived, never deleted, so the
-- history of "what was this rule created from" survives.
CREATE TABLE IF NOT EXISTS public.billing_rule_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  rule        JSONB NOT NULL,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

COMMENT ON TABLE public.billing_rule_templates IS
  'Reusable derived-billing rule shapes. No client_id — a template applies to any client. Archived (archived_at), never deleted.';

CREATE INDEX IF NOT EXISTS billing_rule_templates_active_idx
  ON public.billing_rule_templates (name) WHERE archived_at IS NULL;

ALTER TABLE public.billing_rule_templates ENABLE ROW LEVEL SECURITY;

-- Readable by any signed-in employee (they pick templates when creating a
-- task); all writes go through server actions, same REVOKE pattern as
-- workspaces and the rest of the Connect tables.
DROP POLICY IF EXISTS billing_rule_templates_select ON public.billing_rule_templates;
CREATE POLICY billing_rule_templates_select ON public.billing_rule_templates
  FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.billing_rule_templates FROM authenticated, anon;

COMMIT;
