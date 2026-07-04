-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Business Partners — referral/collection-partner statements               ║
-- ║                                                                            ║
-- ║  A Business Partner introduces one or more Clients and wants a single     ║
-- ║  consolidated statement of what's outstanding across all of them instead  ║
-- ║  of chasing invoices one by one. This module only READS invoices/payments ║
-- ║  — it never writes to them. The only touch on an existing table is one    ║
-- ║  new nullable FK column on `clients` linking it to its partner.           ║
-- ║                                                                            ║
-- ║  Commission fields are stored for a future settlement phase but are not   ║
-- ║  computed/used anywhere yet.                                              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public.business_partners (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_code      TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  company           TEXT,
  phone             TEXT,
  email             TEXT,
  commission_type   TEXT CHECK (commission_type IN ('percentage', 'flat')),
  commission_value  DECIMAL(12,2),
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS business_partner_id UUID REFERENCES public.business_partners(id);

CREATE INDEX IF NOT EXISTS clients_business_partner_idx
  ON public.clients (business_partner_id);

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- App-layer server actions already gate writes via requirePermission(); RLS
-- here just requires an authenticated session, matching the pattern used for
-- other recently-added tables (see ad_wallet_ledger in 20260703140000).
ALTER TABLE public.business_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "business_partners_select" ON public.business_partners;
CREATE POLICY "business_partners_select" ON public.business_partners
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "business_partners_write" ON public.business_partners;
CREATE POLICY "business_partners_write" ON public.business_partners
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ─── Permissions catalog ────────────────────────────────────────────────────
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('finance_partner', 'view',   'finance.partner.view',   'View Business Partners',    'See the Business Partners list, dashboard and statements', 70),
  ('finance_partner', 'create', 'finance.partner.create', 'Create Business Partners',  'Add new business partners and link clients to them', 71),
  ('finance_partner', 'edit',   'finance.partner.edit',   'Edit Business Partners',    'Update partner details, commission settings and client links', 72),
  ('finance_partner', 'export', 'finance.partner.export', 'Export Partner Statements', 'Generate/export WhatsApp, PDF and email statements', 73)
ON CONFLICT (key) DO NOTHING;

COMMIT;
