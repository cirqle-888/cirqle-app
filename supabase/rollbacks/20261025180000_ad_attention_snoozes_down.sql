-- Rollback: removes snoozes only; no other data depends on this table.
BEGIN;
DROP TABLE IF EXISTS public.ad_attention_snoozes;
COMMIT;
