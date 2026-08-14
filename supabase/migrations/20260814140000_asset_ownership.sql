-- Asset ownership: who does a discovered Page / IG account / ad account belong to?
--
-- One agency Meta login reaches every client's assets AND Cirqle's own. Until
-- now every discovered asset was stamped with the connecting client, so
-- Cirqle's own Page would land inside a client's reports and a newly found
-- asset was indistinguishable from a deliberately assigned one.
--
-- Three states, explicit:
--   'client'      belongs to the client in client_id — appears in that client's
--                 reports, dashboards, leads and billing
--   'cirqle'      Cirqle's own marketing — NEVER appears in any client view
--   'unassigned'  discovered, not yet triaged — appears in no client view
--
-- Backward compatible by construction:
--   • owner_type defaults to 'client', so every existing row keeps its current
--     meaning and every existing query returns exactly what it did before
--   • client_id only becomes NULLABLE (a widening); no existing row changes
--   • a CHECK guarantees owner_type='client' still implies a client_id, so the
--     old NOT NULL invariant survives where it actually mattered
--
-- assigned_at is the anti-clobber flag: sync/rediscovery may set an owner only
-- while it is NULL. Once a human has decided, the machine stops guessing.

BEGIN;

-- ── social_accounts (Facebook Pages, Instagram accounts) ────────────────────
ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS owner_type  TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_by UUID;

ALTER TABLE public.social_accounts ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.social_accounts DROP CONSTRAINT IF EXISTS social_accounts_owner_type_ck;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_owner_type_ck
  CHECK (owner_type IN ('client', 'cirqle', 'unassigned'));

ALTER TABLE public.social_accounts DROP CONSTRAINT IF EXISTS social_accounts_owner_client_ck;
ALTER TABLE public.social_accounts ADD CONSTRAINT social_accounts_owner_client_ck
  CHECK (owner_type <> 'client' OR client_id IS NOT NULL);

-- ── ad_accounts ─────────────────────────────────────────────────────────────
ALTER TABLE public.ad_accounts
  ADD COLUMN IF NOT EXISTS owner_type  TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_by UUID;

ALTER TABLE public.ad_accounts ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.ad_accounts DROP CONSTRAINT IF EXISTS ad_accounts_owner_type_ck;
ALTER TABLE public.ad_accounts ADD CONSTRAINT ad_accounts_owner_type_ck
  CHECK (owner_type IN ('client', 'cirqle', 'unassigned'));

ALTER TABLE public.ad_accounts DROP CONSTRAINT IF EXISTS ad_accounts_owner_client_ck;
ALTER TABLE public.ad_accounts ADD CONSTRAINT ad_accounts_owner_client_ck
  CHECK (owner_type <> 'client' OR client_id IS NOT NULL);

-- ── lead_forms ──────────────────────────────────────────────────────────────
ALTER TABLE public.lead_forms
  ADD COLUMN IF NOT EXISTS owner_type  TEXT NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_by UUID;

ALTER TABLE public.lead_forms DROP CONSTRAINT IF EXISTS lead_forms_owner_type_ck;
ALTER TABLE public.lead_forms ADD CONSTRAINT lead_forms_owner_type_ck
  CHECK (owner_type IN ('client', 'cirqle', 'unassigned'));

-- lead_forms.client_id was already nullable; a form with owner_type='client'
-- and no client is meaningless, so hold the same invariant here.
ALTER TABLE public.lead_forms DROP CONSTRAINT IF EXISTS lead_forms_owner_client_ck;
ALTER TABLE public.lead_forms ADD CONSTRAINT lead_forms_owner_client_ck
  CHECK (owner_type <> 'client' OR client_id IS NOT NULL);

-- ── leads ───────────────────────────────────────────────────────────────────
-- A lead inherits its owner from the Page/form that captured it: a lead from
-- Cirqle's own lead ad is Cirqle's, and must not appear in a client's CRM.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'client';

ALTER TABLE public.leads ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_owner_type_ck;
ALTER TABLE public.leads ADD CONSTRAINT leads_owner_type_ck
  CHECK (owner_type IN ('client', 'cirqle', 'unassigned'));

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_owner_client_ck;
ALTER TABLE public.leads ADD CONSTRAINT leads_owner_client_ck
  CHECK (owner_type <> 'client' OR client_id IS NOT NULL);

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Every client-facing read filters on (owner_type, client_id); every triage
-- screen filters on owner_type alone.
CREATE INDEX IF NOT EXISTS social_accounts_owner_idx ON public.social_accounts (owner_type, client_id);
CREATE INDEX IF NOT EXISTS ad_accounts_owner_idx     ON public.ad_accounts (owner_type, client_id);
CREATE INDEX IF NOT EXISTS lead_forms_owner_idx      ON public.lead_forms (owner_type, client_id);
CREATE INDEX IF NOT EXISTS leads_owner_idx           ON public.leads (owner_type, client_id);

-- ── Permissions ─────────────────────────────────────────────────────────────
-- Assigning an asset moves money and reporting between clients, so it is its
-- own permission rather than riding on social.manage.
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('assets', 'assign', 'assets.assign', 'Assign assets to clients',
   'Change which client a Page, Instagram account, ad account or lead form belongs to, including marking assets as Cirqle-owned', 87),
  ('assets', 'view_cirqle', 'assets.view_cirqle', 'View Cirqle''s own accounts',
   'See the agency''s own Pages, ad accounts and internal marketing performance', 88)
ON CONFLICT (key) DO NOTHING;

-- Grant both to every designation that already administers advertising, so the
-- new pages are reachable on day one without a manual permissions pass.
INSERT INTO public.designation_permissions (designation_id, permission_id)
SELECT dp.designation_id, p.id
  FROM public.designation_permissions dp
  JOIN public.permissions existing ON existing.id = dp.permission_id
  CROSS JOIN public.permissions p
 WHERE existing.key = 'advertising.manage_providers'
   AND p.key IN ('assets.assign', 'assets.view_cirqle')
ON CONFLICT DO NOTHING;

COMMIT;
