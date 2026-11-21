-- ============================================================================
-- Brands — Cirqle's own sub-brands as a first-class dimension
-- ============================================================================
-- Additive and idempotent. Safe to re-run.
--
-- Cirqle runs more than one brand of its own: Cirqle Works (the agency itself),
-- Cirqle Flyers (offer flyers for supermarkets) and Memoura (personalised
-- gifts), with more to come. Until now the app knew only "Cirqle" — anything
-- with no client — so the brands' pages, ads, work and money were one bucket.
--
-- A brand sits INSIDE the company scope; it is not a client and never will be.
-- Everything that keeps Cirqle's own work unbilled and out of client reports
-- (client_id NULL, scope = 'company', owner_type = 'cirqle') is untouched. The
-- brand only says WHICH of Cirqle's brands a row belongs to:
--
--   social_accounts.brand_id   — a Cirqle-owned Page / Instagram account
--   ad_projects.brand_id       — a company (internal) campaign
--   tasks.brand_id             — internal work (client_id NULL)
--   cashbook_entries.brand_id  — a company income or expense
--   services.brand_id          — the brand that SELLS a service, so client
--                                revenue from it counts toward that brand
--
-- NULL everywhere means "the default brand" (Cirqle Works), so every existing
-- row reads exactly as before.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.brands (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  tagline          TEXT,
  color            TEXT,                         -- hex, e.g. #7c3aed
  logo_url         TEXT,
  whatsapp_number  TEXT,
  website          TEXT,
  -- Exactly one brand is the default: Cirqle itself. Unbranded rows count here.
  is_default       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Print this brand's name/logo/WhatsApp on invoices whose every line is one
  -- of its services. The legal seller (company name, GST, bank) never changes.
  show_on_invoices BOOLEAN NOT NULL DEFAULT FALSE,
  display_order    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS brands_slug_key ON public.brands (slug);
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_lower_key ON public.brands (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS brands_one_default ON public.brands (is_default) WHERE is_default;

DROP TRIGGER IF EXISTS update_brands_modtime ON public.brands;
CREATE TRIGGER update_brands_modtime
  BEFORE UPDATE ON public.brands FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Names, colours and logos are not secret; every signed-in user may read them.
-- Writes go through the server (service role) only.
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brands_read ON public.brands;
CREATE POLICY brands_read ON public.brands
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
REVOKE ALL ON public.brands FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.brands FROM authenticated;
GRANT SELECT ON public.brands TO authenticated;

-- ── Brand columns ────────────────────────────────────────────────────────────
ALTER TABLE public.social_accounts  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.ad_projects      ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.tasks            ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.cashbook_entries ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.services         ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS social_accounts_brand_idx  ON public.social_accounts  (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ad_projects_brand_idx      ON public.ad_projects      (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_brand_idx            ON public.tasks            (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cashbook_entries_brand_idx ON public.cashbook_entries (brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS services_brand_idx         ON public.services         (brand_id) WHERE brand_id IS NOT NULL;

COMMENT ON COLUMN public.social_accounts.brand_id  IS 'Which Cirqle brand a Cirqle-owned account belongs to. NULL = the default brand.';
COMMENT ON COLUMN public.ad_projects.brand_id      IS 'Which Cirqle brand a company campaign promotes. NULL = the default brand.';
COMMENT ON COLUMN public.tasks.brand_id            IS 'Which Cirqle brand internal work (client_id NULL) is for. NULL = the default brand.';
COMMENT ON COLUMN public.cashbook_entries.brand_id IS 'Which Cirqle brand a company entry belongs to. NULL = the default brand / shared.';
COMMENT ON COLUMN public.services.brand_id         IS 'The Cirqle brand that sells this service. NULL = the default brand.';

-- tasks uses column-level SELECT grants (20261116120000): a new column is
-- invisible to the browser until granted. brand_id carries no money.
GRANT SELECT (brand_id) ON public.tasks TO authenticated;

-- ── Seed the three brands that exist today ──────────────────────────────────
INSERT INTO public.brands (name, slug, tagline, color, whatsapp_number, is_default, display_order)
VALUES
  ('Cirqle Works',  'cirqle-works',  'Creative & marketing studio',          '#1a2744', NULL,             TRUE,  0),
  ('Cirqle Flyers', 'cirqle-flyers', 'Offer flyers for supermarkets & shops', '#7c3aed', '+91 83018 39488', FALSE, 1),
  ('Memoura',       'memoura',       'Personalised gifts from your photos',  '#6b1f4a', NULL,             FALSE, 2)
ON CONFLICT (slug) DO NOTHING;

-- ── Backfill: accounts by their Meta ids (stable across environments) ──────
UPDATE public.social_accounts s SET brand_id = b.id
  FROM public.brands b
 WHERE s.brand_id IS NULL AND s.owner_type = 'cirqle'
   AND b.slug = CASE
     WHEN s.external_id IN ('110078878680298', '17841452678483986')   THEN 'cirqle-works'
     WHEN s.external_id IN ('1503454559512815', '17841464165460062')  THEN 'cirqle-flyers'
     WHEN s.external_id IN ('1467331489801771', '17841460112874126')  THEN 'memoura'
   END;

-- Company campaigns already pointing at a page take that page's brand.
UPDATE public.ad_projects p SET brand_id = s.brand_id
  FROM public.social_accounts s
 WHERE p.brand_id IS NULL AND p.client_id IS NULL
   AND p.page_account_id = s.id AND s.brand_id IS NOT NULL;

-- The Offer Flyers service category is what Cirqle Flyers sells.
UPDATE public.services sv SET brand_id = b.id
  FROM public.brands b, public.service_categories c
 WHERE sv.brand_id IS NULL AND b.slug = 'cirqle-flyers'
   AND sv.category_id = c.id AND c.name = 'Offer Flyers';

NOTIFY pgrst, 'reload schema';

COMMIT;
