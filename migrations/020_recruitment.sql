-- ============================================================================
-- 020 — Recruitment / Careers module
--
-- Public careers page (cirqle.work/careers) → CRM-hosted public application
-- route (/careers/apply, no login) → this schema → CRM Recruitment module
-- (Open Positions / Applications / Interviews / Offers / Reports).
--
-- Design notes:
--   • No email-based applications anywhere — every submission is a row in
--     job_applications, written server-side via the admin client (same as
--     every other public-token flow in this app: /intake, /start).
--   • "application_activity" was requested as a 4th supporting table, but this
--     codebase already has a universal, permission-aware activity timeline
--     (activity_logs + src/lib/activity/{log,timeline,timeline-copy}.ts —
--     Cirqle Connect Wave A). Per this project's own architecture rule
--     ("reuse existing helpers, do not duplicate"), recruitment events are
--     logged there instead via a new `application_id` scope column (mirrors
--     client_id/project_id/task_id from migration 014). See
--     RECRUITMENT_MODULE.md for the full rationale.
--   • Two extra tables beyond the requested four (application_interviews,
--     application_offers) were added because "Interview Management" and the
--     "Offers" sidebar page both need real backing state — a stage string on
--     job_applications alone can't hold a schedule, an interviewer, or an
--     offered salary/expiry.
--   • Reference numbers use the SAME atomic per-period-sequence pattern as
--     migration 011 (cashbook receipt numbers): a small counter table +
--     a SECURITY DEFINER function, race-safe via INSERT ... ON CONFLICT.
-- ============================================================================

-- ── 1. job_positions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  department      text,
  location        text,
  is_remote       boolean NOT NULL DEFAULT false,
  employment_type text NOT NULL DEFAULT 'full_time'
                  CHECK (employment_type IN ('full_time','part_time','contract','internship','freelance')),
  description     text,
  requirements    text,
  openings        int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','on_hold','closed')),
  created_by      uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_positions_status ON job_positions (status, created_at DESC);

-- ── 2. job_applications ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_number   text UNIQUE NOT NULL,               -- CIRQLE-HR-2026-0001
  position_id        uuid REFERENCES job_positions(id) ON DELETE SET NULL,
  position_title     text NOT NULL,                       -- snapshot: survives position edits/deletes
  full_name          text NOT NULL,
  email              text NOT NULL,
  phone              text,
  country             text,
  location           text,
  experience         text,                                 -- free text, e.g. "3 years" / "Fresher"
  expected_salary    numeric(12,2),
  availability       text,                                 -- e.g. "Immediate", "30 days notice"
  portfolio_url      text,
  linkedin_url       text,
  resume_storage_path text,                                -- storage.objects path in 'recruitment-resumes'
  cover_letter       text,
  skills             text[] NOT NULL DEFAULT '{}',
  why_join           text,
  stage              text NOT NULL DEFAULT 'new'
                     CHECK (stage IN (
                       'new','screening','interview_scheduled','interview_completed',
                       'technical_review','selected','offer_sent','joined','rejected'
                     )),
  source             text NOT NULL DEFAULT 'careers_page',
  rejected_reason     text,
  assigned_to         uuid REFERENCES employees(id) ON DELETE SET NULL,
  submitted_ip        text,                                 -- lightweight abuse/rate-limit signal only
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_applications_stage    ON job_applications (stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_applications_position ON job_applications (position_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_applications_email    ON job_applications (lower(email));
CREATE INDEX IF NOT EXISTS idx_job_applications_created  ON job_applications (created_at DESC);

-- ── 3. application_notes — internal only, applicants never have accounts ────
CREATE TABLE IF NOT EXISTS application_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES employees(id),
  note           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_application_notes_app ON application_notes (application_id, created_at DESC);

-- ── 4. application_documents — resume + any extra files ──────────────────────
CREATE TABLE IF NOT EXISTS application_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  doc_type       text NOT NULL DEFAULT 'resume'
                 CHECK (doc_type IN ('resume','cover_letter','portfolio','other')),
  storage_path   text NOT NULL,
  file_name      text,
  mime_type      text,
  size_bytes     bigint,
  uploaded_by    uuid REFERENCES employees(id) ON DELETE SET NULL, -- NULL = applicant self-upload
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_application_documents_app ON application_documents (application_id, created_at DESC);

-- ── 5. application_interviews — scheduling + status ──────────────────────────
CREATE TABLE IF NOT EXISTS application_interviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  scheduled_at     timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 30,
  interviewer_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  meeting_link     text,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  outcome_notes    text,
  reminder_sent_at timestamptz,
  created_by       uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_interviews_app       ON application_interviews (application_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_interviews_upcoming  ON application_interviews (status, scheduled_at) WHERE status = 'scheduled';

-- ── 6. application_offers ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS application_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  position_title text,
  offered_salary numeric(12,2),
  currency       text NOT NULL DEFAULT 'INR',
  start_date     date,
  expiry_date    date,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','accepted','declined','expired')),
  notes          text,
  sent_at        timestamptz,
  responded_at   timestamptz,
  created_by     uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_offers_app    ON application_offers (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_offers_status ON application_offers (status, created_at DESC);

-- ── 7. Reference number generator (same pattern as migration 011) ───────────
-- Format: CIRQLE-HR-{YYYY}-{seq:04d}, global sequence per calendar year.
CREATE TABLE IF NOT EXISTS hr_reference_sequences (
  year_key text PRIMARY KEY,   -- 'YYYY'
  next_seq int NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION generate_hr_reference_number(p_date TEXT DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year TEXT;
  v_seq  INTEGER;
BEGIN
  v_year := to_char(COALESCE(p_date::DATE, CURRENT_DATE), 'YYYY');

  INSERT INTO hr_reference_sequences (year_key, next_seq)
    VALUES (v_year, 2)
  ON CONFLICT (year_key) DO UPDATE
    SET next_seq = hr_reference_sequences.next_seq + 1
  RETURNING next_seq - 1
  INTO v_seq;

  RETURN 'CIRQLE-HR-' || v_year || '-' || lpad(v_seq::TEXT, 4, '0');
END;
$$;

-- ── 8. Storage bucket for resumes/portfolios ─────────────────────────────────
-- Private bucket. All access via short-lived signed URLs (2-step signed
-- upload for the public form, same recipe as 'chat-attachments' in 016).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'recruitment-resumes',
  'recruitment-resumes',
  false,
  15728640,   -- 15 MB per file
  NULL        -- any type; server action validates (pdf/doc/docx/rtf expected)
)
ON CONFLICT (id) DO NOTHING;

-- ── 9. Universal Timeline integration ────────────────────────────────────────
-- Adds a 5th scope column to the existing activity_logs backbone (mirrors
-- client_id/project_id/task_id from migration 014) instead of a bespoke
-- application_activity table. logActivity()/getTimeline() are extended in
-- application code (src/lib/activity/*.ts) to read/write it.
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES job_applications(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_activity_application ON activity_logs (application_id, created_at DESC) WHERE application_id IS NOT NULL;

-- ── 10. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE job_positions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_offers     ENABLE ROW LEVEL SECURITY;

-- Open positions are not sensitive — safe to expose to anon (a future public
-- "browse jobs" list could read them directly). The public /careers/apply
-- page itself uses the admin client server-side, same as /intake, so this
-- policy is defense-in-depth rather than a hard requirement.
DROP POLICY IF EXISTS job_positions_select_open ON job_positions;
CREATE POLICY job_positions_select_open ON job_positions FOR SELECT
  USING (status = 'open');

-- Any signed-in employee sees every position (incl. on_hold/closed) in the CRM.
DROP POLICY IF EXISTS job_positions_select_employees ON job_positions;
CREATE POLICY job_positions_select_employees ON job_positions FOR SELECT
  USING (current_employee_id() IS NOT NULL);

-- Everything applicant-PII-bearing: employees only. No policy at all exists
-- for anon/unauthenticated reads, so applicants (who never get an auth
-- account) structurally cannot see their own or anyone else's application,
-- notes, documents, interviews or offers — satisfies "applicants cannot see
-- internal notes" by construction, not just by convention.
DROP POLICY IF EXISTS job_applications_select_employees ON job_applications;
CREATE POLICY job_applications_select_employees ON job_applications FOR SELECT
  USING (current_employee_id() IS NOT NULL);

DROP POLICY IF EXISTS application_notes_select_employees ON application_notes;
CREATE POLICY application_notes_select_employees ON application_notes FOR SELECT
  USING (current_employee_id() IS NOT NULL);

DROP POLICY IF EXISTS application_documents_select_employees ON application_documents;
CREATE POLICY application_documents_select_employees ON application_documents FOR SELECT
  USING (current_employee_id() IS NOT NULL);

DROP POLICY IF EXISTS application_interviews_select_employees ON application_interviews;
CREATE POLICY application_interviews_select_employees ON application_interviews FOR SELECT
  USING (current_employee_id() IS NOT NULL);

DROP POLICY IF EXISTS application_offers_select_employees ON application_offers;
CREATE POLICY application_offers_select_employees ON application_offers FOR SELECT
  USING (current_employee_id() IS NOT NULL);

-- Writes: server-action-only via the admin (service role) client, which
-- bypasses RLS entirely — REVOKE just makes sure no direct browser/anon
-- write path exists, matching every other module in this app.
REVOKE INSERT, UPDATE, DELETE ON job_positions          FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON job_applications       FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON application_notes      FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON application_documents  FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON application_interviews FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON application_offers     FROM authenticated, anon;

-- ── 11. Permission keys ───────────────────────────────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('recruitment', 'view',
    'recruitment.view', 'View recruitment',
    'View job positions, applications, interviews, offers and reports', 110),
  ('recruitment', 'edit',
    'recruitment.edit', 'Edit recruitment',
    'Create/edit job positions, move applications through the pipeline, schedule interviews, send offers', 111),
  ('recruitment', 'delete',
    'recruitment.delete', 'Delete recruitment records',
    'Delete job positions and applications', 112),
  ('recruitment', 'interview',
    'recruitment.interview', 'Conduct interviews',
    'Be assignable as an interviewer and record interview outcomes', 113),
  ('recruitment', 'admin',
    'recruitment.admin', 'Recruitment admin',
    'Full control including permanently deleting applications and closing out offers', 114)
ON CONFLICT (key) DO NOTHING;
