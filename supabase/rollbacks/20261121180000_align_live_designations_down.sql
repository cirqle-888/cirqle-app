-- Undo 20261121180000_align_live_designations.
-- Removes exactly the 10 permissions it added. None of them existed (on or off)
-- before it ran — checked against production on 21 Nov 2026 — so removing the
-- rows returns each designation to how it was.
BEGIN;
DELETE FROM public.designation_permissions dp
 USING public.designations d, public.permissions p
 WHERE dp.designation_id = d.id AND dp.permission_id = p.id
   AND (d.name, p.key) IN (
     ('Designer',                                'prompt_studio.view'),
     ('Client Success & Social Media Executive', 'social.publish'),
     ('Client Success & Social Media Executive', 'social.view_insights'),
     ('Billing & Accounts Executive',            'finance.partner.view'),
     ('Billing & Accounts Executive',            'packages.view'),
     ('Billing & Accounts Executive',            'packages.view_pricing'),
     ('Billing & Accounts Executive',            'bank_reconciliation.view'),
     ('Billing & Accounts Executive',            'bank_reconciliation.manage'),
     ('Billing & Accounts Executive',            'card_reconciliation.view'),
     ('Billing & Accounts Executive',            'card_reconciliation.manage'));
COMMIT;
