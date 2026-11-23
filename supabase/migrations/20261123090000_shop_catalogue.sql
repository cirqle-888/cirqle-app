-- ============================================================================
-- Shop catalogue — what the Memoura website sells and announces
-- ============================================================================
-- Additive and idempotent. Safe to re-run: seeds never overwrite an edit.
--
-- Until now the gifts, prices, top banner and delivery charges lived in a file
-- inside the website, so switching a gift off or changing an offer meant
-- editing code. These three tables move that into the app. The website reads
-- them through one public, read-only endpoint (/api/shop/memoura) and falls
-- back to its own built-in copy if the app cannot be reached.
--
-- Nothing here is personal data (it is the public price list), but the tables
-- are still server-only: RLS on, no browser grants. The app writes behind
-- orders.manage and the public endpoint reads with the service role and sends
-- out only the fields the website shows.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.shop_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL,                       -- the website's id for the gift; also names its drawing
  name         TEXT NOT NULL,
  meta         TEXT,                                -- short line under the name: "20 pieces", "A5"
  price        NUMERIC(12,2) NOT NULL DEFAULT 0,
  pieces       INTEGER,                             -- pieces in a set; shows "about ₹x each"
  badge        TEXT,                                -- "New", "Most loved"
  description  TEXT,
  needs        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- what the buyer sends: ["20 photos", ...]
  who          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- her, him, friends, abroad
  occ          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- birthday, anniversary
  ready        BOOLEAN NOT NULL DEFAULT FALSE,      -- our own design, no customer photos needed
  image_url    TEXT,                                -- a photo: full link, or a file name in the site's assets/photos
  active       BOOLEAN NOT NULL DEFAULT TRUE,       -- off = hidden on the website
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_products_slug_key ON public.shop_products (slug);
CREATE INDEX IF NOT EXISTS shop_products_live_idx ON public.shop_products (sort) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.shop_banners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT,                                -- bold words at the start
  body         TEXT NOT NULL,                       -- the rest of the line
  starts_on    DATE,                                -- empty = from now
  ends_on      DATE,                                -- empty = until switched off
  free_extra   TEXT CHECK (free_extra IS NULL OR free_extra IN ('wrap','note','express')),
  free_with    TEXT,                                -- slug of the gift that earns the free extra
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shop_banners_live_idx ON public.shop_banners (sort) WHERE deleted_at IS NULL;

-- One row of settings per shop: print sizes, delivery charges, extras, highlight cards.
CREATE TABLE IF NOT EXISTS public.shop_settings (
  shop        TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_shop_products_modtime ON public.shop_products;
CREATE TRIGGER update_shop_products_modtime BEFORE UPDATE ON public.shop_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_shop_banners_modtime ON public.shop_banners;
CREATE TRIGGER update_shop_banners_modtime BEFORE UPDATE ON public.shop_banners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS update_shop_settings_modtime ON public.shop_settings;
CREATE TRIGGER update_shop_settings_modtime BEFORE UPDATE ON public.shop_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_banners  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_products, public.shop_banners, public.shop_settings FROM anon, authenticated;

COMMENT ON TABLE public.shop_products IS 'Gifts sold on the Memoura website. Server-only; the site reads them through /api/shop/memoura.';
COMMENT ON TABLE public.shop_banners  IS 'The announcement strip at the top of the Memoura website, with optional dates and a free extra.';
COMMENT ON TABLE public.shop_settings IS 'Per-shop settings as one JSON value: print sizes, delivery charges, extras, highlight cards.';

-- ── Seed: exactly what the website shows today ───────────────────────────────
INSERT INTO public.shop_products (slug, name, meta, price, pieces, badge, description, needs, who, occ, ready, sort) VALUES
  ('polaroid', 'Mini polaroid pack', '20 pieces', 199, 20, 'Smile Drop pick',
    'Twenty of your photos as mini polaroids with handwritten-style captions.',
    '["20 photos","Captions, if you want them"]', '["her","him","friends"]', '["birthday"]', FALSE, 10),
  ('song', 'Song frame', 'A5', 249, NULL, NULL,
    'Your photo with a ''your song'' player design, name and date.',
    '["1 photo","Song name and singer","Names and date"]', '["her","him","friends"]', '["anniversary"]', FALSE, 20),
  ('strip', 'Photo strip frame', '4 photos', 299, NULL, NULL,
    'A photobooth-style strip of four photos in a black frame.',
    '["4 photos","A short line or date"]', '["her","him","friends"]', '["anniversary"]', FALSE, 30),
  ('magazine', 'Memory magazine', '12 pages', 449, NULL, 'Most loved',
    'A real printed magazine about them: cover story, photos and your words.',
    '["15 to 25 photos","Their name and the occasion","A few lines about them (we help you write)"]', '["her","friends"]', '["birthday","anniversary"]', FALSE, 40),
  ('collage', 'Collage frame', 'A4', 549, NULL, NULL,
    'Up to 12 photos arranged by our designers, framed and ready to hang.',
    '["6 to 12 photos","Names or a short message"]', '["her","him"]', '["birthday","anniversary"]', FALSE, 50),
  ('standee', 'Standee cut-out', '8 inch', 699, NULL, NULL,
    'A cut-out of the person on a wooden stand. Made for reaction videos.',
    '["1 clear full-length photo"]', '["him","her","friends"]', '["birthday"]', FALSE, 60),
  ('lamp', 'Photo lamp frame', 'warm light', 799, NULL, NULL,
    'A round photo lit by a soft warm lamp. Their bedside favourite.',
    '["1 photo"]', '["her","him"]', '["anniversary"]', FALSE, 70),
  ('hamper', 'Mini surprise hamper', 'box set', 1499, NULL, NULL,
    'Polaroids, a song frame, chocolates and a note in our gift box.',
    '["10 photos","Song name","Your message for the note"]', '["her","friends"]', '["birthday","anniversary"]', FALSE, 80),
  ('grand', 'Grand memory box', 'box set', 2999, NULL, NULL,
    'Memory magazine, lamp frame, polaroids and flowers. The big surprise.',
    '["25 photos or more","Their name and the occasion","Your message"]', '["her"]', '["anniversary","birthday"]', FALSE, 90),
  ('abroad', 'Gift from abroad box', 'doorstep surprise', 3499, NULL, NULL,
    'Sent by you from abroad, delivered to the family''s door, with a reaction video.',
    '["Your photos and message","Delivery address in India","The date for the surprise"]', '["abroad"]', '["birthday","anniversary"]', FALSE, 100)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.shop_products (slug, name, meta, price, pieces, badge, description, needs, who, occ, ready, sort) VALUES
  ('wallpola', 'Wall polaroid set', '12 pieces, our designs', 149, 12, 'New',
    'Twelve polaroid-style prints in one colour mood, ready for your wall.',
    '[]', '["her","him","friends"]', '["birthday"]', TRUE, 110),
  ('split', 'Split poster set', '3 panels, A4', 249, 3, NULL,
    'One design split across three panels for a big wall look.',
    '[]', '["him","friends"]', '["birthday"]', TRUE, 120)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.shop_banners (title, body, starts_on, ends_on, free_extra, free_with, active, sort)
SELECT 'The Smile Drop', '1 to 10 Dec: Mini polaroid pack ₹199 with free gift wrap',
       DATE '2026-12-01', DATE '2026-12-10', 'wrap', 'polaroid', TRUE, 10
 WHERE NOT EXISTS (SELECT 1 FROM public.shop_banners);

INSERT INTO public.shop_settings (shop, value) VALUES ('memoura', '{
  "freeShippingAbove": 999,
  "delivery": { "kerala": 69, "india": 99 },
  "extras": { "wrap": 49, "note": 29, "express": 99 },
  "sizes": [
    { "key": "mini", "name": "Mini", "note": "polaroid size",  "price": 15 },
    { "key": "a6",   "name": "A6",   "note": "10.5 × 14.8 cm", "price": 25 },
    { "key": "a5",   "name": "A5",   "note": "14.8 × 21 cm",   "price": 39 },
    { "key": "a4",   "name": "A4",   "note": "21 × 29.7 cm",   "price": 69 },
    { "key": "a3",   "name": "A3",   "note": "29.7 × 42 cm",   "price": 129 }
  ],
  "spotlight": [
    { "id": "wallpola", "title": "Fill your wall for {price}", "text": "Twelve polaroid prints in one colour mood, {each}. No photos needed." },
    { "id": "polaroid", "title": "Your 20 best photos, {price}", "text": "Mini polaroids with captions, {each}. Made from your own photos." }
  ]
}'::jsonb)
ON CONFLICT (shop) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
