-- 027: split the Advertising money layer into two view permissions.
--
--   advertising.view_financials — the WALLET layer: client/company wallet
--     balances, credited top-ups, transaction history, Add Funds.
--   advertising.view_billing    — what the agency BILLS the client: service
--     charge type/value/%, computed billing, task billing amounts, invoices
--     and service rate cards.
--
-- Campaign ALLOCATIONS are deliberately behind NEITHER key: an allocation is
-- the campaign's working budget, and every advertising.view holder sees it.
--
-- Why two keys: a campaign handler (media buyer, social executive) needs
-- campaigns, allocations and daily metrics but must not see the agency's
-- margins; a wallet-watcher may reconcile top-ups without seeing margins
-- either. Without a key the server strips the fields before render.
--
-- Grants: admins, plus every designation that already holds
-- advertising.manage_budget (you cannot manage a budget you cannot see).

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('advertising', 'view_financials', 'advertising.view_financials', 'View Advertising Wallets',
    'See client/company wallet balances, credited top-ups and wallet transaction history in Advertising', 78),
  ('advertising', 'view_billing', 'advertising.view_billing', 'View Advertising Billing',
    'See service charges, billing amounts, invoices and service rate cards in Advertising', 79)
ON CONFLICT (key) DO NOTHING;

-- Admin designations.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('advertising.view_financials', 'advertising.view_billing')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Anyone already trusted to manage budgets keeps seeing the money.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, p.id, TRUE
  FROM public.designation_permissions dp
  JOIN public.permissions mb ON mb.id = dp.permission_id AND mb.key = 'advertising.manage_budget'
  JOIN public.permissions p  ON p.key IN ('advertising.view_financials', 'advertising.view_billing')
 WHERE dp.allowed = TRUE
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
