-- check-rls.sql
-- Fails if any table in the public schema has RLS disabled.
SELECT
  tablename
FROM
  pg_tables
WHERE
  schemaname = 'public'
  AND rowsecurity = false;
