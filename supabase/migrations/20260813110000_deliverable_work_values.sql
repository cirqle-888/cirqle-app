-- ═══════════════════════════════════════════════════════════════════════════
-- DELIVERABLE WORK VALUES (Phase 2)
--
-- Adds work_value_inr to client_agreement_deliverables to allow packages
-- (one_time items) to specify exact work values for each of their deliverables.
--
-- Rollback: supabase/rollbacks/20260813110000_deliverable_work_values_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.client_agreement_deliverables 
  ADD COLUMN IF NOT EXISTS work_value_inr NUMERIC(10,2);

COMMIT;
