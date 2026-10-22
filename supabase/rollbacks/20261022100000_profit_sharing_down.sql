-- Rollback for 20261022100000_profit_sharing.sql
--
-- WARNING: this discards every profit-sharing record — investors, capital
-- history, agreements, confirmed periods and their frozen inputs,
-- entitlements, settlements, reviews, devices, valuations and the audit trail.
-- Export the profit_share_* tables first if any period was confirmed or any
-- settlement recorded.
--
-- Cash Book entries created by settlements are NOT deleted: they are real
-- money movements (reference 'profit_share:<settlement id>'). Review them by
-- hand after rolling back.
--
-- The five Cash Book categories are removed only while no entry uses them.
-- Permission rows are left in place deliberately (the same reasoning as
-- 20260807100000_ownership_platform_down.sql): deleting a permission cascades
-- into designation_permissions. To remove them too:
--   DELETE FROM permissions WHERE key IN
--     ('profit_sharing.view','profit_sharing.manage','profit_sharing.approve');
BEGIN;

DROP FUNCTION IF EXISTS public.profit_share_confirm_run(uuid, uuid, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.profit_share_settle(jsonb);
DROP FUNCTION IF EXISTS public.profit_share_record_capital(jsonb);

DROP TABLE IF EXISTS public.profit_share_cash_links;
DROP TABLE IF EXISTS public.profit_share_capital;
DROP TABLE IF EXISTS public.profit_share_settlements;
DROP TABLE IF EXISTS public.profit_share_reviews;
DROP TABLE IF EXISTS public.profit_share_device_valuations;
DROP TABLE IF EXISTS public.profit_share_device_events;
DROP TABLE IF EXISTS public.profit_share_devices;
DROP TABLE IF EXISTS public.profit_share_reserve_movements;
DROP TABLE IF EXISTS public.profit_share_entitlements;
DROP TABLE IF EXISTS public.profit_share_run_inputs;
DROP TABLE IF EXISTS public.profit_share_runs;
DROP TABLE IF EXISTS public.profit_share_settings;
DROP TABLE IF EXISTS public.profit_share_agreements;
DROP TABLE IF EXISTS public.profit_share_members;
DROP TABLE IF EXISTS public.profit_share_events;

DROP FUNCTION IF EXISTS public.profit_share_append_only();
DROP FUNCTION IF EXISTS public.profit_share_runs_guard();
DROP FUNCTION IF EXISTS public.profit_share_capital_guard();
DROP FUNCTION IF EXISTS public.profit_share_capital_balance();
DROP FUNCTION IF EXISTS public.profit_share_agreements_guard();
DROP FUNCTION IF EXISTS public.profit_share_reviews_guard();
DROP FUNCTION IF EXISTS public.profit_share_valuations_guard();
DROP FUNCTION IF EXISTS public.profit_share_settlements_limit();

DELETE FROM public.cashbook_categories c
 WHERE c.name IN ('Capital Introduced','Capital Withdrawn','Profit Share Payout','Loan Received','Loan Repaid')
   AND NOT EXISTS (SELECT 1 FROM public.cashbook_entries e WHERE e.category_id = c.id);

COMMIT;
