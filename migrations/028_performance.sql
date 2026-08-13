-- ============================================================================
-- 028 — Performance Scorecards (HR)
--
-- One scorecard engine for BOTH current employees and job applicants
-- (job_applications), plus free-name "quick measure" runs.
--
-- Design notes:
--   • perf_criteria is ONE self-referencing table: parent_id NULL = a group
--     (Experience, Skills…), parent_id set = a sub-parameter under it.
--     Both levels are fully add/edit/deactivate-able from the UI (Advanced).
--   • Each sub-parameter has a UNIT: percent (default slider), level (1–5),
--     years (vs target years), time (actual vs target minutes — faster is
--     better), count (vs target). Raw value is stored; the score is
--     normalized to 0–100 in application code (src/lib/performance/calc.ts).
--   • Default groups/weights seeded below follow common worldwide HR
--     competency-model practice (skills-heaviest, then experience/tools,
--     communication, versatility). All editable.
--   • Applying a FINAL employee scorecard writes one row into the EXISTING
--     employee_performance_history register (migration untouched), so
--     payroll/contribution math keeps working exactly as before.
--   • Writes go through server actions with the admin client, same as every
--     other module: RLS SELECT for signed-in employees + REVOKE writes.
-- ============================================================================

-- ── 1. Criteria (groups + sub-parameters) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_criteria (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  uuid REFERENCES perf_criteria(id) ON DELETE CASCADE,  -- NULL = group
  name       text NOT NULL,
  -- Weight relative to siblings (groups vs groups, sub-items vs sub-items
  -- within one group). Normalized at calculation time, so they need not
  -- total exactly 100.
  weight     numeric(6,2) NOT NULL DEFAULT 10,
  unit       text NOT NULL DEFAULT 'percent'
             CHECK (unit IN ('percent','level','years','time','count')),
  -- Meaning per unit: years → years for a full score; time → target minutes
  -- for the output; count → count for a full score. NULL for percent/level.
  target     numeric(10,2),
  sort       int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perf_criteria_parent ON perf_criteria (parent_id, sort);

-- ── 2. Assessments (one scorecard run) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_assessments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid REFERENCES employees(id) ON DELETE CASCADE,
  application_id uuid REFERENCES job_applications(id) ON DELETE CASCADE,
  subject_name   text,                       -- quick-measure label when neither id is set
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  final_score    numeric(5,2),               -- set at finalize
  breakdown      jsonb,                      -- per-group snapshot at finalize
  note           text,
  applied_history_id uuid,                   -- employee_performance_history row, once applied
  applied_at     timestamptz,
  created_by     uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (employee_id IS NOT NULL OR application_id IS NOT NULL OR subject_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_perf_assessments_employee    ON perf_assessments (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_assessments_application ON perf_assessments (application_id, created_at DESC);

-- ── 3. Scores (raw value per sub-parameter) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS perf_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES perf_assessments(id) ON DELETE CASCADE,
  criteria_id   uuid NOT NULL REFERENCES perf_criteria(id) ON DELETE CASCADE,
  value         numeric(10,2) NOT NULL,     -- raw, in the criterion's unit
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, criteria_id)
);
CREATE INDEX IF NOT EXISTS idx_perf_scores_assessment ON perf_scores (assessment_id);

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE perf_criteria    ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE perf_scores      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS perf_criteria_select ON perf_criteria;
CREATE POLICY perf_criteria_select ON perf_criteria FOR SELECT
  USING (current_employee_id() IS NOT NULL);
DROP POLICY IF EXISTS perf_assessments_select ON perf_assessments;
CREATE POLICY perf_assessments_select ON perf_assessments FOR SELECT
  USING (current_employee_id() IS NOT NULL);
DROP POLICY IF EXISTS perf_scores_select ON perf_scores;
CREATE POLICY perf_scores_select ON perf_scores FOR SELECT
  USING (current_employee_id() IS NOT NULL);

REVOKE INSERT, UPDATE, DELETE ON perf_criteria    FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON perf_assessments FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON perf_scores      FROM authenticated, anon;

-- ── 5. Permission key ────────────────────────────────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('performance', 'manage',
    'performance.manage', 'Performance scorecards',
    'Open the Performance page, score employees/applicants, edit criteria and apply ratings', 120)
ON CONFLICT (key) DO NOTHING;

-- ── 6. Default criteria seed (edit freely in Advanced) ───────────────────────
-- Group weights follow common worldwide competency-model splits:
-- Skills 25 / Experience 20 / Tools 20 / Communication & Personality 20 /
-- Responsibilities (versatility) 15.
DO $$
DECLARE
  g_exp uuid; g_skill uuid; g_tools uuid; g_resp uuid; g_comm uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM perf_criteria) THEN RETURN; END IF;  -- seed once

  INSERT INTO perf_criteria (name, weight, sort) VALUES ('Experience', 20, 1) RETURNING id INTO g_exp;
  INSERT INTO perf_criteria (name, weight, sort) VALUES ('Skills & Knowledge', 25, 2) RETURNING id INTO g_skill;
  INSERT INTO perf_criteria (name, weight, sort) VALUES ('Tools & Software', 20, 3) RETURNING id INTO g_tools;
  INSERT INTO perf_criteria (name, weight, sort) VALUES ('Responsibilities', 15, 4) RETURNING id INTO g_resp;
  INSERT INTO perf_criteria (name, weight, sort) VALUES ('Communication & Personality', 20, 5) RETURNING id INTO g_comm;

  INSERT INTO perf_criteria (parent_id, name, weight, unit, target, sort) VALUES
    -- Experience: 8+ relevant years = full marks (diminishing value beyond)
    (g_exp,   'Relevant experience',       40, 'years',  8,    1),
    (g_exp,   'Company quality',           30, 'percent', NULL, 2),
    (g_exp,   'Role relevance',            30, 'percent', NULL, 3),

    (g_skill, 'Core job skills',           40, 'percent', NULL, 1),
    (g_skill, 'Cirqle-related knowledge',  30, 'percent', NULL, 2),
    (g_skill, 'Learning speed',            30, 'percent', NULL, 3),

    (g_tools, 'Photoshop — knowledge',     25, 'percent', NULL, 1),
    (g_tools, 'Photoshop — output time',   25, 'time',    60,   2),  -- 60 min target
    (g_tools, 'Illustrator',               25, 'percent', NULL, 3),
    (g_tools, 'Other tools',               25, 'percent', NULL, 4),

    (g_resp,  'Core designation work',     50, 'percent', NULL, 1),
    (g_resp,  'Extra work they can take',  30, 'percent', NULL, 2),
    (g_resp,  'Ownership & initiative',    20, 'percent', NULL, 3),

    (g_comm,  'English',                   20, 'percent', NULL, 1),
    (g_comm,  'Malayalam',                 20, 'percent', NULL, 2),
    (g_comm,  'Hindi',                     10, 'percent', NULL, 3),
    (g_comm,  'Client communication',      25, 'percent', NULL, 4),
    (g_comm,  'Attitude & passion',        25, 'percent', NULL, 5);
END $$;
