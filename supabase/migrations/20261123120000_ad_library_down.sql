-- Reverses 20261123120000_ad_library.sql. Deletes every saved ad, folder and
-- connect key. Files already copied into the ad-library bucket are left in
-- storage; empty and delete the bucket from the Supabase dashboard if wanted.
BEGIN;
DROP TABLE IF EXISTS public.saved_ads;
DROP TABLE IF EXISTS public.ad_folders;
DROP TABLE IF EXISTS public.ad_saver_keys;
COMMIT;
