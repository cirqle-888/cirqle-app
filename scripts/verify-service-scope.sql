-- Post-apply verification for 20260720100000_service_scope_foundation.sql
-- Run in the Supabase SQL editor. Every `present` row must read true.

SELECT 'client_service_pricing.is_active is NOT NULL' AS item,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_name='client_service_pricing' AND column_name='is_active') = 'NO' AS present
UNION ALL
SELECT 'deactivated_at / deactivated_by columns',
       (SELECT count(*) FROM information_schema.columns
         WHERE table_name='client_service_pricing'
           AND column_name IN ('deactivated_at','deactivated_by')) = 2
UNION ALL
SELECT 'commitment indexes',
       (SELECT count(*) FROM pg_indexes WHERE schemaname='public'
         AND indexname IN ('csp_commitment_idx','csp_service_commitment_idx')) = 2
UNION ALL
SELECT 'service_scope_audit table',
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='service_scope_audit')
UNION ALL
SELECT 'audit is append-only (trigger present)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='service_scope_audit_no_mutate')
UNION ALL
SELECT 'scope.by_service + scope.view_all seeded',
       (SELECT count(*) FROM public.permissions
         WHERE key IN ('scope.by_service','scope.view_all')) = 2
UNION ALL
SELECT 'client-narrowing kill switch present',
       EXISTS (SELECT 1 FROM public.company_settings WHERE key='scope_client_services')
UNION ALL
SELECT 'employee_services no longer readable by anon',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='public' AND tablename='employee_services'
                      AND ('anon' = ANY(roles) OR roles = '{public}'));

-- ── Safety: the restriction must be granted to NOBODY on day one ─────────────
-- Expect 0 rows. Any row here means someone is already restricted, which is
-- not what "ships dark" means.
SELECT d.name AS designation, p.key
  FROM public.designation_permissions dp
  JOIN public.designations d ON d.id = dp.designation_id
  JOIN public.permissions  p ON p.id = dp.permission_id
 WHERE p.key = 'scope.by_service' AND dp.allowed;

-- ── Commitment data shape (sanity-read after the backfill script runs) ───────
SELECT
  (SELECT count(*) FROM public.client_service_pricing WHERE is_active)            AS active_commitments,
  (SELECT count(*) FROM public.client_service_pricing WHERE NOT is_active)        AS deactivated,
  (SELECT count(*) FROM public.clients c WHERE c.is_active
      AND NOT EXISTS (SELECT 1 FROM public.client_service_pricing p
                       WHERE p.client_id = c.id AND p.is_active))                 AS clients_with_no_services,
  (SELECT count(*) FROM public.employee_services)                                  AS employee_assignments;

-- ── Commitment drift: work logged against a service the client isn't set up
--    for. Expect this to shrink over time; it is the health panel's key metric.
SELECT c.name AS client, s.name AS service, count(*) AS tasks
  FROM public.tasks t
  JOIN public.clients  c ON c.id = t.client_id
  JOIN public.services s ON s.id = t.service_id
 WHERE t.deleted_at IS NULL AND t.client_id IS NOT NULL AND t.service_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.client_service_pricing p
                    WHERE p.client_id = t.client_id AND p.service_id = t.service_id AND p.is_active)
 GROUP BY c.name, s.name
 ORDER BY tasks DESC
 LIMIT 20;
