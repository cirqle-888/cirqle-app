-- Reverses 20261128220000_feature_visits.sql. Deletes the page-visit history;
-- Feature Usage then falls back to Quick Actions and saved changes only.
BEGIN;
DROP TABLE IF EXISTS public.feature_visits;
COMMIT;
