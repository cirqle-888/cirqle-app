-- ─────────────────────────────────────────────────────────────────────────────
-- Produce library: local-language names, curated image variants, and a
-- client-submittable Product Library intake app.
--
-- WHY
-- B.N. Mart's vegetables flyer is built from a Google Sheet lookup: type
-- "THAKKALI" and a formula fills in the Malayalam name (തക്കാളി) plus two
-- prepared images — a cut-out and a drop-shadow version — from a 101-item
-- produce library held in yet another sheet. That library is doing exactly what
-- Cirqle's global product_catalog already does, minus three things it can't
-- store: a second-language name, more than one curated image treatment per
-- product, and any notion of "a client suggested this, staff should check it".
--
-- Adding those three collapses a four-sheet chain into the catalog Cirqle
-- already maintains, and makes the same library available to every client
-- rather than just the one whose sheet holds it.
--
-- BACKWARD COMPATIBILITY
-- Every column is defaulted, and review_status defaults to 'approved' so the
-- ~existing catalog stays visible and usable exactly as it is today. Nothing
-- reads the new columns unless it opts in.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.product_catalog
  -- Local-language names, keyed by ISO code: {"ml": "തക്കാളി", "ar": "طماطم"}.
  -- Deliberately a map rather than a name_malayalam column — Mezza KSA would
  -- need Arabic, and that must not cost another migration and another UI field.
  ADD COLUMN IF NOT EXISTS names jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Curated library entries are approved on arrival; anything a client submits
  -- waits for staff, so a blurry phone photo or a typo can't reach a printed
  -- flyer unreviewed.
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('approved', 'pending', 'rejected')),
  ADD COLUMN IF NOT EXISTS submitted_by_client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_product_catalog_pending
  ON public.product_catalog(submitted_at DESC) WHERE review_status = 'pending';

-- Image treatments. 'transparent' and 'shadow' are CURATED assets supplied with
-- the library; 'bg_removed' stays what it has always meant — the output of the
-- in-app background remover. Keeping them distinct matters because a designer
-- should prefer the curated cut-out over a machine-generated one.
ALTER TABLE public.product_catalog_images
  DROP CONSTRAINT IF EXISTS product_catalog_images_version_check;
ALTER TABLE public.product_catalog_images
  ADD CONSTRAINT product_catalog_images_version_check
  CHECK (version IN ('original', 'bg_removed', 'flyer_ready', 'thumbnail', 'transparent', 'shadow'));

-- One row per (product, treatment): re-importing the library updates an entry
-- in place instead of stacking duplicates every run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_catalog_images_version
  ON public.product_catalog_images(product_id, version);

-- ── Client-facing Product Library app ────────────────────────────────────────
-- Its own token, separate from offer_intake_token, so it can be shared with a
-- different person (the produce buyer, not the offers coordinator) and revoked
-- on its own.
--
-- The DEFAULT and the backfill are both load-bearing: without them the column
-- is NULL for every client, intakeKindHref() returns null, the app never
-- appears on anyone's hub, and the whole feature is unreachable. Same shape as
-- offer_intake_token in 20240001.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS product_library_token text UNIQUE
    DEFAULT replace(gen_random_uuid()::text, '-', '');

UPDATE public.clients
   SET product_library_token = replace(gen_random_uuid()::text, '-', '')
 WHERE product_library_token IS NULL;

-- ── Permission ───────────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'catalog', 'review_submissions', 'catalog.review_submissions',
  'Review product submissions',
  'Approve or reject products that clients submit through the Product Library link before they become usable on flyers.',
  8
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
FROM public.designations d, public.permissions p
WHERE d.is_admin = TRUE AND p.key IN ('catalog.review_submissions')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
