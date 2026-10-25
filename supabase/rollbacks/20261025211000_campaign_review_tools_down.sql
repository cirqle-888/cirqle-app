-- Roll back application code first. Preserve annotations, requests and lead
-- review columns for audit/recovery instead of destroying user data.
BEGIN;
REVOKE ALL ON public.ad_campaign_annotations, public.ad_budget_requests FROM service_role;
COMMIT;
