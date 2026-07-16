-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Social Media Calendar Planner                                            ║
-- ║                                                                            ║
-- ║  Plan a client's social content on a month grid (posts, reels, stories…)  ║
-- ║  and push planned items into the Requests inbox as real task_requests —   ║
-- ║  from there they ride the EXISTING pipeline unchanged: promote to task,   ║
-- ║  task status mirrors back onto the request (task-sync), and the calendar  ║
-- ║  reads live progress through the item → request → task join.              ║
-- ║                                                                            ║
-- ║  Integration mirrors the advertising pattern (ad_meta, 20260628140000):   ║
-- ║  a nullable social_meta JSONB on task_requests tags calendar-originated   ║
-- ║  requests; shape (app-enforced):                                          ║
-- ║    { calendar_id, item_id, content_type, platforms, scheduled_date }      ║
-- ║                                                                            ║
-- ║  Rollback: supabase/rollbacks/20260716120000_social_calendar_down.sql     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. Calendars: one per client per month ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.social_calendars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  month       DATE NOT NULL,                    -- first day of the planned month
  title       TEXT,                             -- optional label, e.g. "July content plan"
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  notes       TEXT,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, month)
);

CREATE INDEX IF NOT EXISTS social_calendars_client_idx
  ON public.social_calendars (client_id, month DESC);

-- ── 2. Planned items ─────────────────────────────────────────────────────────
-- status is the AUTHORED state only: planned → requested (pushed to Requests)
-- or cancelled. Live progress (in progress / delivered / completed) is never
-- stored here — it is read through request_id → task_requests → promoted task,
-- so the calendar can never drift from the pipeline's truth.

CREATE TABLE IF NOT EXISTS public.social_calendar_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id    UUID NOT NULL REFERENCES public.social_calendars(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  title          TEXT NOT NULL,
  content_type   TEXT NOT NULL DEFAULT 'post'
                   CHECK (content_type IN ('post','reel','story','carousel','video','flyer','other')),
  platforms      TEXT[] NOT NULL DEFAULT '{}',  -- instagram / facebook / youtube / linkedin / tiktok / x / whatsapp
  caption        TEXT,                          -- draft copy for the designer
  notes          TEXT,                          -- internal brief notes
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','requested','cancelled')),
  request_id     UUID REFERENCES public.task_requests(id) ON DELETE SET NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,    -- ordering within a day
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_calendar_items_calendar_idx
  ON public.social_calendar_items (calendar_id, scheduled_date);

-- UNIQUE: one item ↔ one request. Together with the conditional claim in
-- pushItemsToRequests (UPDATE … WHERE request_id IS NULL) this makes
-- double-pushing an item impossible even under concurrent pushes.
CREATE UNIQUE INDEX IF NOT EXISTS social_calendar_items_request_idx
  ON public.social_calendar_items (request_id) WHERE request_id IS NOT NULL;

-- ── 3. Tag on task_requests (the ad_meta pattern) ────────────────────────────

ALTER TABLE public.task_requests ADD COLUMN IF NOT EXISTS social_meta JSONB;

CREATE INDEX IF NOT EXISTS task_requests_social_meta_idx
  ON public.task_requests ((social_meta IS NOT NULL)) WHERE social_meta IS NOT NULL;

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
-- TO authenticated (the advertising module's pattern, 20260628120000:215) —
-- NOT the bare USING(true) some older tables still carry: policies without a
-- TO clause apply to PUBLIC, which includes the `anon` role whose key ships in
-- the browser bundle (migrations/006_rls_enforce_auth.sql exists precisely to
-- retire that). These tables hold client content plans, captions and internal
-- brief notes; no anonymous access is ever needed — every read/write in this
-- module goes through createAdminClient() (service role, bypasses RLS).
-- Real authorization is app-level: social.view / social.manage.

ALTER TABLE public.social_calendars      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_calendar_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.social_calendars;
DROP POLICY IF EXISTS "social_calendars_authenticated_all" ON public.social_calendars;
CREATE POLICY "social_calendars_authenticated_all"
ON public.social_calendars FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable read access for all users" ON public.social_calendar_items;
DROP POLICY IF EXISTS "social_calendar_items_authenticated_all" ON public.social_calendar_items;
CREATE POLICY "social_calendar_items_authenticated_all"
ON public.social_calendar_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 5. Permissions ───────────────────────────────────────────────────────────

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('social', 'view',   'social.view',
    'View Social Calendar', 'See the social media calendar planner and its plans', 80),
  ('social', 'manage', 'social.manage',
    'Manage Social Calendar', 'Create/edit content plans and send planned items to the Requests inbox', 81)
ON CONFLICT (key) DO NOTHING;

-- Auto-grant to admin designations (mirrors advertising/request portal).
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('social.view', 'social.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
