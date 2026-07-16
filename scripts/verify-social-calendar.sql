-- Post-apply verification for 20260716120000_social_calendar.sql
-- Run in the Supabase SQL editor after applying. All `present` rows must be true.

SELECT 'social_calendars table' AS item,
       EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='social_calendars') AS present
UNION ALL
SELECT 'social_calendar_items table',
       EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='social_calendar_items')
UNION ALL
SELECT 'task_requests.social_meta column',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='task_requests' AND column_name='social_meta')
UNION ALL
-- to_regclass (not ::regclass) — the cast RAISES on a missing relation, which
-- would abort the whole presence report exactly when it is most needed.
SELECT 'one-calendar-per-client-month unique',
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = to_regclass('public.social_calendars') AND contype='u')
UNION ALL
SELECT 'RLS restricted to authenticated (no anon access)',
       NOT EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname='public'
            AND tablename IN ('social_calendars','social_calendar_items')
            AND ('anon' = ANY(roles) OR roles = '{public}')
       )
UNION ALL
SELECT 'social.view + social.manage permissions seeded',
       (SELECT COUNT(*) FROM public.permissions WHERE key IN ('social.view','social.manage')) = 2;

-- Integrity: every 'requested' item must point at a request; every linked
-- request must carry the social_meta tag. Expect 0 rows from both.
SELECT i.id, i.title, 'requested but no request_id' AS problem
  FROM social_calendar_items i
 WHERE i.status = 'requested' AND i.request_id IS NULL
UNION ALL
SELECT i.id, i.title, 'linked request missing social_meta'
  FROM social_calendar_items i
  JOIN task_requests r ON r.id = i.request_id
 WHERE r.social_meta IS NULL;

-- Snapshot: plans and their push progress (sanity-read).
SELECT c.month, cl.name AS client, c.status,
       COUNT(i.id)                                   AS items,
       COUNT(i.request_id)                           AS sent_to_requests,
       COUNT(*) FILTER (WHERE r.promoted_task_id IS NOT NULL) AS promoted_to_tasks
  FROM social_calendars c
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN social_calendar_items i ON i.calendar_id = c.id
  LEFT JOIN task_requests r ON r.id = i.request_id
 GROUP BY c.id, c.month, cl.name, c.status
 ORDER BY c.month DESC;
