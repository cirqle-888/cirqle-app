-- ─────────────────────────────────────────────────────────────────────────────
-- Make the shared catalog reachable by clients, and leave a seam for regions.
--
-- THE PROBLEM
-- The 101-item produce library imported into product_catalog was invisible to
-- every client: the offer form's product picker reads client_product_catalog,
-- which only ever contains what THAT client has submitted before. The library
-- had 0 client_product_assignments rows, so a shop owner typing "Tomato" got no
-- suggestion, no Malayalam name and no curated photo — the whole point of it.
--
-- THE APPROACH
-- Global-by-default, expressed as the absence of a restriction rather than as
-- rows. Assigning all 100 products to all 61 clients would mean 6,100 join rows
-- to keep correct on every new product and every new client, and it would still
-- say nothing about WHY a client can see something.
--
-- Instead a product is visible to a client when its region is NULL ("sells
-- everywhere") or matches the client's own region. Today every row is NULL, so
-- every approved product is available to everyone — which is what is wanted
-- while all clients are in Kerala — and no backfill is needed.
--
-- THE FUTURE
-- When a Dubai client is onboarded: set clients.region = 'AE-DXB', tag the
-- genuinely Kerala-only produce with region = 'IN-KL', and leave everything
-- that sells in both places NULL. Nothing else changes; the filter is already
-- in the query. Region is deliberately free text rather than an enum so the
-- first non-Kerala client does not need a migration to be created.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.product_catalog
  -- NULL = available in every region. Set it only to RESTRICT a product.
  ADD COLUMN IF NOT EXISTS region text;

ALTER TABLE public.clients
  -- NULL = this client sees only unrestricted products, which is correct for a
  -- client whose region has not been decided yet.
  ADD COLUMN IF NOT EXISTS region text;

-- Partial index: the common lookup is "everything not restricted", and the
-- restricted rows are expected to stay a small minority.
CREATE INDEX IF NOT EXISTS idx_product_catalog_region
  ON public.product_catalog(region) WHERE region IS NOT NULL;

-- The picker filters on these together; approved+active is the hot path.
CREATE INDEX IF NOT EXISTS idx_product_catalog_available
  ON public.product_catalog(review_status, status);
