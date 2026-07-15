-- Rollback for 20260714170000_client_partner_since.sql
ALTER TABLE public.clients DROP COLUMN IF EXISTS partner_since;
