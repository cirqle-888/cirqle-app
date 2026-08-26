-- ============================================================================
-- packages.view_pricing — see a package's coverage without seeing its fee
-- ============================================================================
-- Additive, idempotent, INSERT-only. Safe to re-run.
--
-- WHY
-- Until now packages.view was all-or-nothing, and deliberately so — the source
-- said "a package's whole point is its agreed price, so there is no
-- field-level split here". In practice that forces an unwanted choice: someone
-- who needs to know what a client committed to and how much is delivered has
-- to be shown the fee as well, or be shut out of the coverage view entirely.
--
-- This is the same split already used for billing.view_amounts and
-- tasks.view_pricing: the page renders in full either way, and the MONEY
-- (client_packages.price, extra_task_price, and the billing_amount on linked
-- tasks) is stripped server-side for anyone without this key. Stripped, not
-- hidden with CSS — the figures never reach the browser at all.
--
-- NOT A BREAKING CHANGE
-- Every designation that can currently see packages can currently see their
-- prices, and this migration preserves that exactly: the new key is granted to
-- every designation already holding packages.view. Nobody loses a figure they
-- had yesterday. Revoke it deliberately, per designation, to take prices away.
-- ============================================================================

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('packages', 'view_pricing', 'packages.view_pricing',
   'View Package Pricing',
   'See the agreed price, overage rate and task billing amounts on packages. Without it the package still shows what was committed and how much is delivered — just no money.',
   167)
ON CONFLICT (key) DO NOTHING;

-- Admins hold every key.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'packages.view_pricing'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Preserve today's behaviour: anyone who can see packages keeps seeing prices.
-- Without this the migration would silently strip figures from every existing
-- role the moment it ran.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, np.id, TRUE
  FROM public.designation_permissions dp
  JOIN public.permissions op ON op.id = dp.permission_id AND op.key = 'packages.view'
  CROSS JOIN public.permissions np
 WHERE dp.allowed = TRUE
   AND np.key = 'packages.view_pricing'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
