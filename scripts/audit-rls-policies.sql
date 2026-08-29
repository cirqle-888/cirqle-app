-- ============================================================================
-- RLS / GRANT AUDIT — 100% READ-ONLY. Paste into the Supabase SQL editor.
-- ============================================================================
-- Returns the ground truth PostgREST cannot expose: which relations have RLS,
-- what each policy actually says, which roles hold grants, and which views
-- bypass RLS. Nothing is written; no row data is selected from any app table.
--
-- Run all five sections and paste the output back.
-- ============================================================================

-- ── 1. Every relation: kind, RLS state, and who holds SELECT ────────────────
-- relkind: r=table  v=view  m=materialized view  p=partitioned
SELECT
  c.relname                                        AS relation,
  c.relkind                                        AS kind,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','v','m','p')
ORDER BY
  -- most dangerous first: anon can read it, or RLS is off
  (has_table_privilege('anon', c.oid, 'SELECT'))::int DESC,
  c.relrowsecurity ASC,
  c.relname;

-- ── 2. Every policy, in full ────────────────────────────────────────────────
SELECT
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual        AS using_expression,
  with_check  AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;

-- ── 3. Tables with RLS ON but NO policy (deny-all) or a blanket TRUE ────────
SELECT
  c.relname AS relation,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.polname) AS policy_count,
  BOOL_OR(pg_get_expr(p.polqual, p.polrelid) = 'true') AS has_blanket_using_true
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
GROUP BY c.relname, c.relrowsecurity
ORDER BY has_blanket_using_true DESC NULLS LAST, policy_count ASC, c.relname;

-- ── 4. Views: do they bypass RLS? (security_invoker off = bypass) ───────────
SELECT
  c.relname AS view_name,
  c.relkind AS kind,
  pg_get_userbyid(c.relowner) AS owner,
  COALESCE(
    (SELECT option_value FROM pg_options_to_table(c.reloptions)
      WHERE option_name = 'security_invoker'), 'false'
  ) AS security_invoker,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
ORDER BY anon_select DESC, security_invoker, c.relname;

-- ── 5. SECURITY DEFINER functions (they run as owner, bypassing RLS) ────────
SELECT
  p.proname       AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef     AS security_definer,
  pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef = true
ORDER BY p.proname;
