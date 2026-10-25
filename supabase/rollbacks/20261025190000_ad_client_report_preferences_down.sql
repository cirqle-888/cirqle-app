-- Rollback: drops saved composer defaults only; reports are unaffected.
BEGIN;
DROP TABLE IF EXISTS public.ad_client_report_preferences;
COMMIT;
