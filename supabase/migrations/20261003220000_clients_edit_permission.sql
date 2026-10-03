-- Edit Clients permission
--
-- Editing a client (details, service pricing, archive / restore) needed
-- settings.access, which also opens designations, company settings and the
-- rest of Settings. A Task Manager could see a client page but not edit it,
-- and the "Edit Client" button bounced them to the dashboard.
--
-- `clients.edit` is accepted alongside settings.access by every client write
-- (updateClient, upsertClientServicePricings, deactivateClientServices,
-- deactivateClient, reactivateClient, quickEditClient), so this only ADDS
-- access — nobody who could edit before loses it, and the code works whether
-- or not this has run.
--
-- Granted to: admins, every designation that already holds settings.access
-- (they could edit clients before), and Task Manager (requested 2026-10-03).
-- Adjust per designation in Settings → Designations afterwards.

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('clients', 'edit', 'clients.edit', 'Edit Clients',
    'Edit existing clients — details, service pricing, archive and restore — without full Settings access', 31)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT DISTINCT d.id, p.id, TRUE
  FROM public.designations d
  CROSS JOIN public.permissions p
 WHERE p.key = 'clients.edit'
   AND (
     d.is_admin = TRUE
     OR d.name = 'Task Manager'
     OR EXISTS (
       SELECT 1
         FROM public.designation_permissions dp
         JOIN public.permissions sp ON sp.id = dp.permission_id
        WHERE dp.designation_id = d.id
          AND dp.allowed = TRUE
          AND sp.key = 'settings.access'
     )
   )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
