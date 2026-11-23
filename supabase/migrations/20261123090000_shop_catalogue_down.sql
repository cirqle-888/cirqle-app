-- Reverses 20261123090000_shop_catalogue. DROPS the gifts, banners and shop settings kept in the app.
-- The website then shows its own built-in copy again.
BEGIN;
DROP TABLE IF EXISTS public.shop_products;
DROP TABLE IF EXISTS public.shop_banners;
DROP TABLE IF EXISTS public.shop_settings;
NOTIFY pgrst, 'reload schema';
COMMIT;
