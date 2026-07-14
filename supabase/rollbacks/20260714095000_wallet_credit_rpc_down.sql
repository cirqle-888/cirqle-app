-- Rollback for 20260714095000_wallet_credit_rpc.sql
-- Safe any time: the app detects the missing function and falls back to the
-- (unlocked) TypeScript credit path automatically.

DROP FUNCTION IF EXISTS public.credit_ad_wallet(UUID, UUID, NUMERIC, TEXT, UUID);
