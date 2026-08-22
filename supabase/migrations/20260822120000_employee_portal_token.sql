-- ============================================================================
-- Employee portal token — the migration the app has been waiting on
-- ============================================================================
-- `/portal/[token]` resolves an employee by `employees.portal_token`. That
-- column has never existed in this database: no migration created it, so the
-- portal's first query errors and EVERY portal request falls through to
-- notFound(). The feature is fully built otherwise — portal page, its server
-- actions, and the "Copy portal link" button in Settings, which sits
-- permanently disabled behind the tooltip "No portal token — run SQL
-- migration". This is that migration.
--
-- Additive, idempotent, NON-DESTRUCTIVE — pure DDL plus a backfill of the new
-- column, safe to run in the Supabase SQL editor.
--
-- SECURITY: the token is a bearer credential — anyone holding the URL sees
-- that employee's tasks, contribution scores and earnings without logging in.
-- It is therefore generated from gen_random_bytes (cryptographically random,
-- 32 bytes → 64 hex chars), NOT from the employee id, cqid, or anything else
-- guessable. `anon` is deliberately NOT granted anything here: the portal
-- reads through the service role, matching how the route already works.
-- ============================================================================

BEGIN;

-- pgcrypto provides gen_random_bytes. Supabase ships it, but be explicit so
-- this migration stands alone.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS portal_token TEXT;

-- One token per employee, and a fast lookup for the portal's .eq() probe.
-- Partial: NULL means "portal not issued", and many employees may share that.
CREATE UNIQUE INDEX IF NOT EXISTS employees_portal_token_key
  ON public.employees (portal_token)
  WHERE portal_token IS NOT NULL;

-- Backfill: issue a token to every employee that lacks one. Re-running this
-- migration never rotates an existing token — a rotation would silently break
-- links already shared with staff.
UPDATE public.employees
   SET portal_token = encode(gen_random_bytes(32), 'hex')
 WHERE portal_token IS NULL;

COMMIT;

-- ── Rotating a single employee's token (revokes their old link) ─────────────
-- UPDATE public.employees
--    SET portal_token = encode(gen_random_bytes(32), 'hex')
--  WHERE cqid = 'CQ001';
