-- ─────────────────────────────────────────────────────────────────────────────
-- service_scope_audit: allow the 'updated' action.
--
-- 20260720100000 seeded the CHECK with added/removed/activated/deactivated —
-- enough for assignment changes, but a commitment can also be REPRICED without
-- its active state changing (a Pricing Matrix cell edit, a bulk import). That
-- is a commitment change worth recording: it moves money, and the old/new
-- price belongs in the same trail as everything else.
--
-- Additive and safe to run against a populated table: widening a CHECK cannot
-- invalidate existing rows.
--
-- Rollback: supabase/rollbacks/20260720110000_scope_audit_updated_action_down.sql
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.service_scope_audit
  DROP CONSTRAINT IF EXISTS service_scope_audit_action_check;

ALTER TABLE public.service_scope_audit
  ADD CONSTRAINT service_scope_audit_action_check
  CHECK (action IN ('added', 'removed', 'activated', 'deactivated', 'updated'));
