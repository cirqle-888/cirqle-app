-- ============================================================================
-- Brand scope — brands work like departments
-- ============================================================================
-- Additive and idempotent. Safe to re-run. Builds on 20261122100000_brands.
--
-- In this app a DEPARTMENT is a service category (Offer Flyers, Social Media,
-- Print, …): clients are filed under the departments of what they buy, staff
-- are assigned departments (employee_service_categories), and "restrict to own
-- department" reads exactly that. A brand is now one level above:
--
--     Brand ──owns──▶ Departments ──hold──▶ Services
--     Cirqle Flyers   Offer Flyers           Offer Flyer, A3 Offer Flyer, …
--     Memoura         Personalised Gifts     (products added by the team)
--     Cirqle Works    everything else (NULL brand = the default brand)
--
-- So everything departments already do extends to brands with no new rules:
--   · a client's brands  = the brands of its departments
--   · a service's brand  = its own override (services.brand_id) or its
--                          department's brand
--   · staff assigned to a BRAND (employee_brands) get every department of that
--     brand — resolved at read time, like a department assignment, so a
--     department added to the brand later is picked up automatically
--
-- Memoura sells to people, not businesses: its orders are tasks, its customers
-- are clients, and `task_label` lets the app call its tasks "Orders".
-- ============================================================================

BEGIN;

-- ── Departments belong to a brand ───────────────────────────────────────────
ALTER TABLE public.service_categories
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS service_categories_brand_idx
  ON public.service_categories (brand_id) WHERE brand_id IS NOT NULL;
COMMENT ON COLUMN public.service_categories.brand_id IS
  'The Cirqle brand this department belongs to. NULL = the default brand (Cirqle Works).';

-- ── Staff assigned to a whole brand ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_brands (
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  brand_id    UUID NOT NULL REFERENCES public.brands(id)    ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, brand_id)
);
CREATE INDEX IF NOT EXISTS employee_brands_brand_idx ON public.employee_brands (brand_id);
-- Same posture as employee_service_categories: read and written by the server.
ALTER TABLE public.employee_brands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_brands FROM anon, authenticated;

-- ── What a brand calls its work ─────────────────────────────────────────────
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS task_label TEXT;
COMMENT ON COLUMN public.brands.task_label IS
  'What this brand calls a task, e.g. "Order" for Memoura. NULL = "Task".';

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Offer Flyers is Cirqle Flyers' department.
UPDATE public.service_categories c SET brand_id = b.id
  FROM public.brands b
 WHERE c.brand_id IS NULL AND b.slug = 'cirqle-flyers' AND c.name = 'Offer Flyers';

-- Memoura gets a department of its own to hold its products.
INSERT INTO public.service_categories (name, slug, color, display_order, is_active, brand_id)
SELECT 'Personalised Gifts', 'personalised-gifts', '#6b1f4a',
       COALESCE((SELECT MAX(display_order) FROM public.service_categories), 0) + 1, TRUE, b.id
  FROM public.brands b
 WHERE b.slug = 'memoura'
   AND NOT EXISTS (SELECT 1 FROM public.service_categories WHERE lower(name) = 'personalised gifts');

-- Memoura's tasks are orders.
UPDATE public.brands SET task_label = 'Order' WHERE slug = 'memoura' AND task_label IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
