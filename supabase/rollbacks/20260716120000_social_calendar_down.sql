-- Rollback for 20260716120000_social_calendar.sql
-- Drops the planner tables and the task_requests tag column. Requests created
-- FROM the calendar are ordinary task_requests and deliberately survive — they
-- are real work items in the pipeline; only their social_meta tag is lost.

DROP TABLE IF EXISTS public.social_calendar_items;
DROP TABLE IF EXISTS public.social_calendars;

DROP INDEX IF EXISTS task_requests_social_meta_idx;
ALTER TABLE public.task_requests DROP COLUMN IF EXISTS social_meta;

DELETE FROM public.designation_permissions
 WHERE permission_id IN (SELECT id FROM public.permissions WHERE key IN ('social.view','social.manage'));
DELETE FROM public.permissions WHERE key IN ('social.view','social.manage');
