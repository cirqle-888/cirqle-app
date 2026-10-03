-- Draft (trial) clients
--
-- Some prospects ask for trial posters/creatives before they sign. Staff
-- need to plan that content, raise requests and assign tasks for them, but
-- they are not clients yet and must not be billed. A draft client is an
-- ordinary `clients` row with `is_draft = true`:
--
--   * it appears in the Tasks, Requests and Social Calendar client pickers
--     (labelled "Draft"), so work can be planned and assigned;
--   * it is kept OUT of every invoice generator until approved;
--   * an approver (clients.create / settings.access) turns it into a real
--     client from the Clients page — or archives it if the trial goes nowhere.
--
-- `clients.create_draft` lets a designation add drafts (with full details)
-- without being able to add real clients. Nobody gets it by default: switch
-- it on per designation in Settings → Designations. Admins always have it.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS is_draft          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS draft_note        TEXT,
  ADD COLUMN IF NOT EXISTS draft_created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_created_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS draft_approved_by UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_approved_at TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.is_draft IS
  'Trial/prospect client added from a planning screen. Usable for requests, plans and tasks; excluded from invoice generation until approved.';
COMMENT ON COLUMN public.clients.draft_note IS
  'What the trial is for, e.g. "3 trial posters for Onam".';

CREATE INDEX IF NOT EXISTS clients_is_draft_idx ON public.clients (is_draft) WHERE is_draft;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('clients', 'create_draft', 'clients.create_draft', 'Add Draft Clients',
    'Add a prospect as a draft (trial) client from Tasks, Requests or the Social Calendar, with full details, so trial work can be planned and assigned before they sign. Drafts are never invoiced until approved.', 30)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'clients.create_draft'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
