-- ============================================================
-- External Request Portal (v1)
-- ============================================================
-- Clients/agencies submit work requests through public, tokenized intake
-- links. Requests live in an isolated inbox (task_requests) and never touch
-- Tasks/Contributions/Payroll until explicitly promoted via Add Task.
-- The request_activity timeline (with per-entry visibility) is the source of
-- truth for all external/internal actions.
--
-- STRICTLY ADDITIVE — no existing table is modified.
-- See REQUEST_PORTAL_DESIGN.md for the full architecture.
-- ============================================================

-- 1. Agencies — external partners (first-class, parallel to clients) ------------
CREATE TABLE IF NOT EXISTS public.agencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  contact_name  text,
  email         text,
  phone         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 2. Intake links — tokenized share links ---------------------------------------
CREATE TABLE IF NOT EXISTS public.intake_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  type          text NOT NULL DEFAULT 'client' CHECK (type IN ('client','agency','generic')),
  client_id     uuid REFERENCES public.clients(id)  ON DELETE CASCADE,
  agency_id     uuid REFERENCES public.agencies(id) ON DELETE CASCADE,
  label         text,
  is_active     boolean NOT NULL DEFAULT true,
  expires_at    timestamptz,
  created_by    uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS intake_links_token_idx ON public.intake_links (token) WHERE is_active = true;

-- 3. Task requests — the inbox (core) -------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no        integer GENERATED ALWAYS AS IDENTITY,        -- displayed as REQ-0042
  track_token   text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),  -- per-request tracking link (generic submitters)
  link_id       uuid REFERENCES public.intake_links(id) ON DELETE SET NULL,
  source        text NOT NULL DEFAULT 'client' CHECK (source IN ('client','agency','generic','manual')),
  client_id     uuid REFERENCES public.clients(id)  ON DELETE SET NULL,
  agency_id     uuid REFERENCES public.agencies(id) ON DELETE SET NULL,
  submitter_name  text,
  submitter_email text,
  submitter_phone text,
  title         text NOT NULL,
  description   text,
  remarks       text,
  design_plan   text,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date      date,
  is_planned    boolean NOT NULL DEFAULT false,              -- agency "future campaign"
  status        text NOT NULL DEFAULT 'submitted' CHECK (status IN
                  ('submitted','under_review','approved','started','in_progress',
                   'waiting_for_content','revision_requested','completed','delivered',
                   'rejected','archived')),
  client_status text NOT NULL DEFAULT 'submitted',           -- external-facing projection of status
  last_external_activity_at timestamptz DEFAULT now(),       -- drives the inbox "new update" indicator
  last_staff_viewed_at      timestamptz,                     -- set when staff open the request
  content_link      text,
  reference_link    text,
  deliverables_link text,
  drive_folder_link text,
  extra_links   jsonb NOT NULL DEFAULT '[]',                 -- [{label,url}]
  service_id    uuid REFERENCES public.services(id) ON DELETE SET NULL,
  assigned_employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  promoted_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  promoted_at   timestamptz,
  promoted_by   uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  internal_notes text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX IF NOT EXISTS task_requests_status_idx ON public.task_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS task_requests_client_idx ON public.task_requests (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_requests_agency_idx ON public.task_requests (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_requests_promoted_idx ON public.task_requests (promoted_task_id) WHERE promoted_task_id IS NOT NULL;

-- 4. Activity timeline — source of truth (external + internal) -------------------
CREATE TABLE IF NOT EXISTS public.request_activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES public.task_requests(id) ON DELETE CASCADE,
  actor_type   text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('client','agency','admin','system')),
  actor_id     uuid,                                          -- employee id when actor_type=admin
  actor_label  text,                                          -- display name ("Sea Star", "Staff")
  action       text NOT NULL,                                 -- submitted | field_changed | link_added | status_changed | note | revision_requested | promoted | ...
  visibility   text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client','agency')),
  detail       jsonb,                                         -- {field,from,to} or {message}
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_activity_req_idx ON public.request_activity (request_id, visibility, created_at);

-- 5. Revisions — tracked to closure ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.request_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES public.task_requests(id) ON DELETE CASCADE,
  requested_by_type text NOT NULL DEFAULT 'client' CHECK (requested_by_type IN ('client','agency','admin')),
  note              text NOT NULL,
  link              text,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);
CREATE INDEX IF NOT EXISTS request_revisions_req_idx ON public.request_revisions (request_id, status);

-- 6. Permissions -----------------------------------------------------------------
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('requests', 'view',   'requests.view',   'View Requests Inbox',
    'See the external Requests inbox and request details', 60),
  ('requests', 'review', 'requests.review', 'Review Requests',
    'Move requests to Under Review, Approve or Reject them', 61),
  ('requests', 'start',  'requests.start',  'Start / Promote Requests',
    'Promote a request into a real task (opens Add Task prefilled)', 62),
  ('requests', 'manage', 'requests.manage', 'Manage Requests',
    'Edit request fields, set Waiting/Revision states, archive requests', 63),
  ('requests', 'activity_view', 'requests.activity.view', 'View Request Activity',
    'See the full internal + external activity timeline of a request', 64),
  ('intake_links', 'manage', 'intake_links.manage', 'Manage Client Intake Links',
    'Create, revoke and regenerate client + generic intake links', 65),
  ('agency_links', 'manage', 'agency_links.manage', 'Manage Agency Links',
    'Create, revoke and regenerate agency intake links (and agencies)', 66)
ON CONFLICT (key) DO NOTHING;

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('requests.view','requests.review','requests.start','requests.manage',
                 'requests.activity.view','intake_links.manage','agency_links.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
