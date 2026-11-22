-- ============================================================================
-- Align the live designations with the workflow guide
-- ============================================================================
-- Prepared 21 Nov 2026 from a read of production. Additive, INSERT only.
-- Replaces 20261121120000_recommended_designations.sql — that file created six
-- NEW designations; production already has designations that fit the team
-- (Billing & Accounts Executive, Client Success & Social Media Executive,
-- Flyer Designer, Designer), so it is withdrawn. Do not run it.
--
-- Adds 10 permissions that each role's workflow needs and that were never set
-- (no row at all) on 21 Nov 2026:
--
--   Designer (CQID004, CQID006)
--     prompt_studio.view ........... use Prompt Studio (cannot edit Client Cards)
--
--   Client Success & Social Media Executive (CQID005)
--     social.publish ............... To Post, Compose, Comments; create posts and
--                                    SEND THEM FOR APPROVAL (social.approve stays
--                                    with Admin, so nothing goes live without you)
--     social.view_insights ......... Social → Insights
--
--   Billing & Accounts Executive (CQID002) — already sees all billing and cash
--   book totals, so none of these widens what money they can see much:
--     finance.partner.view ......... Business Partners
--     packages.view, packages.view_pricing ... package progress and price, for invoicing
--     bank_reconciliation.view / .manage ..... Bank Reconciliation
--     card_reconciliation.view / .manage ..... Card Statements
--
-- DELIBERATELY NOT ADDED
--   • anything the owner switched OFF in Settings (Designer: dashboard,
--     own contributions; Flyer Designer: social; Client Success: advertising,
--     contributions, links; Billing: request activity). The guard below stops
--     the whole script if any wanted row already exists, on or off.
--   • clients.view for Client Success — it shows client balances and pricing.
--   • reports.* — Billing Reconciliation also opens client profitability.
--   • social.approve, social.connect, assets.assign, settings.*, payroll.*.
--
-- After running: Settings → Access preview for CQID002, CQID004, CQID005;
-- add a row to supabase/APPLIED.md. Undo: rollbacks/20261121180000_align_live_designations_down.sql
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _wanted (role_name text, perm_key text) ON COMMIT DROP;
INSERT INTO _wanted VALUES
  ('Designer',                                'prompt_studio.view'),
  ('Client Success & Social Media Executive', 'social.publish'),
  ('Client Success & Social Media Executive', 'social.view_insights'),
  ('Billing & Accounts Executive',            'finance.partner.view'),
  ('Billing & Accounts Executive',            'packages.view'),
  ('Billing & Accounts Executive',            'packages.view_pricing'),
  ('Billing & Accounts Executive',            'bank_reconciliation.view'),
  ('Billing & Accounts Executive',            'bank_reconciliation.manage'),
  ('Billing & Accounts Executive',            'card_reconciliation.view'),
  ('Billing & Accounts Executive',            'card_reconciliation.manage');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _wanted w
   WHERE NOT EXISTS (SELECT 1 FROM public.permissions  p WHERE p.key  = w.perm_key)
      OR NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.name = w.role_name);
  IF n > 0 THEN RAISE EXCEPTION 'Stopped: % permission key(s) or designation(s) not found. Nothing saved.', n; END IF;

  -- Never override a decision made in Settings: if any wanted permission
  -- already has a row (switched on OR off) for that designation, stop.
  SELECT count(*) INTO n FROM _wanted w
    JOIN public.designations d ON d.name = w.role_name
    JOIN public.permissions  p ON p.key  = w.perm_key
    JOIN public.designation_permissions dp ON dp.designation_id = d.id AND dp.permission_id = p.id;
  IF n > 0 THEN RAISE EXCEPTION 'Stopped: % of these permissions were changed in Settings since 21 Nov. Nothing saved — review them in Settings → Designations.', n; END IF;
END $$;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, true
  FROM _wanted w
  JOIN public.designations d ON d.name = w.role_name
  JOIN public.permissions  p ON p.key  = w.perm_key
ON CONFLICT (designation_id, permission_id) DO NOTHING;

COMMIT;

-- ── Check (run after) — expect 10 rows ──────────────────────────────────────
-- SELECT d.name, p.key FROM public.designation_permissions dp
--   JOIN public.designations d ON d.id = dp.designation_id
--   JOIN public.permissions  p ON p.id = dp.permission_id
--  WHERE dp.allowed AND (d.name, p.key) IN (
--   ('Designer','prompt_studio.view'),
--   ('Client Success & Social Media Executive','social.publish'),
--   ('Client Success & Social Media Executive','social.view_insights'),
--   ('Billing & Accounts Executive','finance.partner.view'),
--   ('Billing & Accounts Executive','packages.view'),
--   ('Billing & Accounts Executive','packages.view_pricing'),
--   ('Billing & Accounts Executive','bank_reconciliation.view'),
--   ('Billing & Accounts Executive','bank_reconciliation.manage'),
--   ('Billing & Accounts Executive','card_reconciliation.view'),
--   ('Billing & Accounts Executive','card_reconciliation.manage'))
--  ORDER BY 1, 2;
