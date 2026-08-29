-- Rollback for 20260801000001_employee_client_preferences.
--
-- Drops the table and every greeting name stored in it. Those are a per-employee
-- display convenience — a nickname shown on the Follow-ups screen — not business
-- records, so losing them costs a re-typing and nothing else. No other table
-- references this one.

drop table if exists public.employee_client_preferences;
