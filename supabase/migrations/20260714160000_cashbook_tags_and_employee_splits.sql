-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Cost Tagging & Employee Cost Attribution                                 ║
-- ║                                                                            ║
-- ║  Two independent, purely additive features on cashbook_entries:           ║
-- ║                                                                            ║
-- ║  1. TAGS — free-form labels ("Photoshop", "Design", …) for ad-hoc spend    ║
-- ║     reporting, orthogonal to the fixed category taxonomy. Many-to-many,   ║
-- ║     normalized (case-insensitive unique) so "Photoshop" and "photoshop"   ║
-- ║     never fork into two buckets.                                          ║
-- ║                                                                            ║
-- ║  2. EMPLOYEE COST SPLITS — attributes a shared expense (e.g. one Adobe    ║
-- ║     seat used by two employees) equally across the employees who         ║
-- ║     benefit from it. This is COST attribution (money spent ON an         ║
-- ║     employee) — distinct from contribution_scores, which is LABOR        ║
-- ║     attribution (money earned BY an employee on client work).            ║
-- ║                                                                            ║
-- ║  No existing table/column changes, no new triggers on cashbook_entries.   ║
-- ║  Zero impact on any current code path if never used.                      ║
-- ║                                                                            ║
-- ║  Rollback: supabase/rollbacks/20260714160000_cashbook_tags_and_employee_splits_down.sql ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── 1. Tags ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashbook_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Photoshop" and "photoshop" are the same tag.
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_tags_name_lower_idx
  ON public.cashbook_tags (lower(name));

CREATE TABLE IF NOT EXISTS public.cashbook_entry_tags (
  cashbook_entry_id UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,
  tag_id            UUID NOT NULL REFERENCES public.cashbook_tags(id)    ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cashbook_entry_id, tag_id)
);

CREATE INDEX IF NOT EXISTS cashbook_entry_tags_tag_idx
  ON public.cashbook_entry_tags (tag_id);

ALTER TABLE public.cashbook_tags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_entry_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cashbook_tags_select" ON public.cashbook_tags;
CREATE POLICY "cashbook_tags_select" ON public.cashbook_tags
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "cashbook_tags_write" ON public.cashbook_tags;
CREATE POLICY "cashbook_tags_write" ON public.cashbook_tags
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "cashbook_entry_tags_select" ON public.cashbook_entry_tags;
CREATE POLICY "cashbook_entry_tags_select" ON public.cashbook_entry_tags
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "cashbook_entry_tags_write" ON public.cashbook_entry_tags;
CREATE POLICY "cashbook_entry_tags_write" ON public.cashbook_entry_tags
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 2. Employee cost splits ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashbook_entry_employee_splits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashbook_entry_id UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES public.employees(id)       ON DELETE CASCADE,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),     -- entry's own currency
  amount_inr        NUMERIC(12,2) NOT NULL CHECK (amount_inr > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cashbook_entry_id, employee_id)
);

CREATE INDEX IF NOT EXISTS cashbook_entry_employee_splits_entry_idx
  ON public.cashbook_entry_employee_splits (cashbook_entry_id);
CREATE INDEX IF NOT EXISTS cashbook_entry_employee_splits_employee_idx
  ON public.cashbook_entry_employee_splits (employee_id);

ALTER TABLE public.cashbook_entry_employee_splits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cashbook_entry_employee_splits_select" ON public.cashbook_entry_employee_splits;
CREATE POLICY "cashbook_entry_employee_splits_select" ON public.cashbook_entry_employee_splits
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "cashbook_entry_employee_splits_write" ON public.cashbook_entry_employee_splits;
CREATE POLICY "cashbook_entry_employee_splits_write" ON public.cashbook_entry_employee_splits
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
