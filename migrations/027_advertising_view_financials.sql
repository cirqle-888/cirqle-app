-- 027: advertising.view_financials — gate the money layer of the Advertising
-- module (wallets, allocations, service charges, GST, billing, invoices).
--
-- Why: campaign handlers (media buyers, social executives) need campaigns and
-- daily metrics but must NOT see what the agency bills the client. Without
-- this key the server strips every financial field/list before render.
--
-- Grants: admins, plus every designation that already holds
-- advertising.manage_budget (you cannot manage a budget you cannot see).

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('advertising', 'view_financials', 'advertising.view_financials', 'View Advertising Financials',
    'See wallets, fund allocations, service charges, GST and billing/invoice amounts in Advertising', 78)
ON CONFLICT (key) DO NOTHING;

-- Admin designations.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'advertising.view_financials'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- Anyone already trusted to manage budgets keeps seeing the money.
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT dp.designation_id, p.id, TRUE
  FROM public.designation_permissions dp
  JOIN public.permissions mb ON mb.id = dp.permission_id AND mb.key = 'advertising.manage_budget'
  JOIN public.permissions p  ON p.key = 'advertising.view_financials'
 WHERE dp.allowed = TRUE
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
