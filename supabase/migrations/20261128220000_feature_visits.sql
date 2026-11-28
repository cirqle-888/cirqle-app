-- ============================================================================
-- feature_visits — which sidebar pages each person opens, one row per day
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Backs Insights → Feature Usage (admin only), which shows the features nobody
-- uses, what each is for and how to start. The app already knew two things —
-- Quick Actions shortcuts (item_usage) and saved changes (activity_logs) — but
-- neither sees a report being read or a page being checked, so a feature used
-- only for looking at looked unused.
--
-- PRIVACY, by design:
--   · one row per person, per sidebar page, per day — never a time of day,
--     a count of clicks, a record id, a query string or a full URL;
--   · `feature_href` is a sidebar page path such as /dashboard/invoices; the
--     app maps every deeper route to that page before writing;
--   · no names, no emails — the person is the employee id (shown as a CQID);
--   · an admin previewing someone ("view as") writes nothing in their name.
--
-- Server-only: RLS on, no browser grants. Rows are written by
-- POST /api/feature-visit and read by the report, both with the service role.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.feature_visits (
  employee_id   UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  feature_href  TEXT NOT NULL
                CHECK (feature_href LIKE '/dashboard%' AND char_length(feature_href) <= 120),
  visit_date    DATE NOT NULL,
  PRIMARY KEY (employee_id, feature_href, visit_date)
);

-- The report reads "the last 90 days", for everyone.
CREATE INDEX IF NOT EXISTS feature_visits_date_idx ON public.feature_visits (visit_date DESC);

ALTER TABLE public.feature_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feature_visits FROM anon, authenticated;

COMMIT;
