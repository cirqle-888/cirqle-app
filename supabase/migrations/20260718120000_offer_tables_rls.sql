-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security for the offer flyer module.
--
-- These tables shipped in 20240001 / 20240003 with RLS never enabled and no
-- policies. In Supabase a table in the `public` schema carries default grants
-- to the `anon` and `authenticated` roles, and RLS is what withholds them —
-- so with it off, the anon key that every browser receives in
-- NEXT_PUBLIC_SUPABASE_ANON_KEY could SELECT/INSERT/UPDATE/DELETE all of them
-- directly through PostgREST. That exposed every client's product pricing for
-- anonymous read and anonymous rewrite.
--
-- This follows the house pattern used by ad_campaigns, social_calendar,
-- cashbook_tags, business_partners and the rest: RLS on, one FOR ALL policy
-- scoped TO authenticated, and the real per-resource authorization enforced in
-- the server actions. The point here is the role scoping — `TO authenticated`
-- rather than a bare USING(true), which would still admit anon.
--
-- Safe for the running app:
--   • Every server action reaches these tables through the service-role admin
--     client, which bypasses RLS entirely.
--   • The one browser-side reader (catalog/import/import-client.tsx, which
--     queries product_catalog) runs inside a signed-in dashboard session, so
--     it satisfies `TO authenticated`.
--   • The public offer intake editor talks to server actions only; it never
--     holds a Supabase client of its own.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'offer_campaigns',
    'offer_products',
    'offer_product_badges',
    'offer_change_logs',
    'offer_badges',
    'client_product_catalog',
    'product_catalog',
    'product_catalog_images',
    'client_product_assignments'
  ]
  LOOP
    -- Skip anything not present rather than aborting the whole migration.
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %: table not present', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t
    );

    -- Belt and braces: revoke the default anon grants outright, so the tables
    -- stay closed to the browser key even if RLS is ever toggled off again.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END $$;
