-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Scenario Snapshots — generic backup-before-apply for the What-If Planner ║
-- ║                                                                            ║
-- ║  Before a simulated scenario is applied to production, every record about ║
-- ║  to change is captured here (old + new values). Deliberately generic      ║
-- ║  (table_name + jsonb): any future module — payroll settings, advertising, ║
-- ║  partner commission, discounts, system config — can snapshot through the  ║
-- ║  same two tables with zero schema changes. This is the seed of a          ║
-- ║  universal rollback/undo mechanism: restore = replay old_values.          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public.scenario_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_name TEXT NOT NULL,
  notes         TEXT,                    -- reason for the change (from the review modal)
  scenario_json JSONB NOT NULL,          -- the full Scenario object (enables "duplicate as new scenario" later)
  record_count  INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES public.employees(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  applied_by    UUID REFERENCES public.employees(id),
  applied_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.scenario_snapshot_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES public.scenario_snapshots(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,             -- 'employees' | 'client_service_pricing' | 'employee_commission_agreements' | future modules
  record_id   TEXT NOT NULL,
  old_values  JSONB NOT NULL,            -- prior state of the changed fields (what a restore replays)
  new_values  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS scenario_snapshot_records_snapshot_idx
  ON public.scenario_snapshot_records (snapshot_id);

-- RLS: same simple authenticated pattern as other recent tables; all writes go
-- through permission-guarded server actions (service role bypasses RLS anyway).
ALTER TABLE public.scenario_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scenario_snapshots_select" ON public.scenario_snapshots;
CREATE POLICY "scenario_snapshots_select" ON public.scenario_snapshots
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "scenario_snapshots_write" ON public.scenario_snapshots;
CREATE POLICY "scenario_snapshots_write" ON public.scenario_snapshots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.scenario_snapshot_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scenario_snapshot_records_select" ON public.scenario_snapshot_records;
CREATE POLICY "scenario_snapshot_records_select" ON public.scenario_snapshot_records
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "scenario_snapshot_records_write" ON public.scenario_snapshot_records;
CREATE POLICY "scenario_snapshot_records_write" ON public.scenario_snapshot_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
