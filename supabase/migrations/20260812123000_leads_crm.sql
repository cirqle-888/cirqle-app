-- ============================================================================
-- Cirqle Leads CRM — Phase 3: Meta Lead Ads → normalized internal leads
-- ============================================================================
-- Cirqle previously had NO lead entity ("clients" was the whole CRM). This
-- creates it, source-agnostic: Meta Lead Ads write here through the webhook +
-- backfill sync, manual/imported leads use the same table.
--
--   leads                 — the CRM lead record (client-scoped)
--   lead_forms            — registry of Meta lead forms per Page
--   lead_automation_rules — configurable "when X happens do Y" rules (spec §11)
-- ============================================================================

BEGIN;

-- ── Leads ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  source               TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('meta_lead_ad','manual','import','website','whatsapp','other')),
  external_lead_id     TEXT,                       -- Meta leadgen_id (dedup key)
  status               TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','qualified','won','lost')),
  full_name            TEXT,
  email                TEXT,
  phone                TEXT,
  raw_fields           JSONB,                      -- full field_data from the form
  -- Attribution (Meta identifiers + display names, captured at retrieval time)
  form_external_id     TEXT,
  form_name            TEXT,
  page_external_id     TEXT,
  campaign_external_id TEXT,
  campaign_name        TEXT,
  adset_external_id    TEXT,
  adset_name           TEXT,
  ad_external_id       TEXT,
  ad_name              TEXT,
  social_account_id    UUID REFERENCES public.social_accounts(id) ON DELETE SET NULL,
  -- Workflow
  assigned_to          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  first_contacted_at   TIMESTAMPTZ,
  notes                TEXT,
  submitted_at         TIMESTAMPTZ,                -- when the person submitted the form
  created_by           UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup: one row per external lead per source (partial — manual leads have no external id)
CREATE UNIQUE INDEX IF NOT EXISTS leads_external_uniq
  ON public.leads (source, external_lead_id) WHERE external_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_client_idx     ON public.leads (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx     ON public.leads (status);
CREATE INDEX IF NOT EXISTS leads_assigned_idx   ON public.leads (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_campaign_idx   ON public.leads (campaign_external_id) WHERE campaign_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_submitted_idx  ON public.leads (submitted_at DESC);

DROP TRIGGER IF EXISTS update_leads_modtime ON public.leads;
CREATE OR REPLACE TRIGGER update_leads_modtime
  BEFORE UPDATE ON public.leads FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Lead PII: readable by signed-in staff (house pattern), writes server-side only.
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_read ON public.leads;
CREATE POLICY leads_read ON public.leads
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Lead form registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_forms (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_account_id  UUID REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  client_id          UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  external_form_id   TEXT NOT NULL,
  name               TEXT,
  status             TEXT,                          -- ACTIVE / ARCHIVED (raw from Meta)
  questions          JSONB,
  leads_count        INTEGER,
  last_lead_at       TIMESTAMPTZ,
  last_synced_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_form_id)
);

CREATE INDEX IF NOT EXISTS lead_forms_account_idx ON public.lead_forms (social_account_id);

ALTER TABLE public.lead_forms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_forms_read ON public.lead_forms;
CREATE POLICY lead_forms_read ON public.lead_forms
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Automation rules (configurable, not hard-coded — spec §11) ──────────────
CREATE TABLE IF NOT EXISTS public.lead_automation_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES public.clients(id) ON DELETE CASCADE,  -- NULL = all clients
  trigger       TEXT NOT NULL
    CHECK (trigger IN ('lead_created','lead_status_changed','lead_uncontacted')),
  -- Trigger qualifier, e.g. {"status":"qualified"} or {"hours":24}
  condition     JSONB,
  action        TEXT NOT NULL
    CHECK (action IN ('assign_employee','create_task_request','notify_employees','notify_admins')),
  -- Action parameters, e.g. {"employee_id":"…"} or {"employee_ids":["…"]}
  action_config JSONB,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_rules_trigger_idx
  ON public.lead_automation_rules (trigger) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_lead_automation_rules_modtime ON public.lead_automation_rules;
CREATE OR REPLACE TRIGGER update_lead_automation_rules_modtime
  BEFORE UPDATE ON public.lead_automation_rules FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.lead_automation_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_rules_read ON public.lead_automation_rules;
CREATE POLICY lead_rules_read ON public.lead_automation_rules
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- ── Permission catalog ───────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('leads', 'view',   'leads.view',   'View Leads',
    'Open the Leads module: lead lists, client lead sections, Meta lead attribution', 95),
  ('leads', 'manage', 'leads.manage', 'Manage Leads',
    'Create/edit/assign leads, change status, configure lead automation rules', 96)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('leads.view','leads.manage')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
