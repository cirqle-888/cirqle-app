-- Clients first-class module (/dashboard/clients) — visibility permission.
-- Pre-migration the module is admin-only (admins bypass the catalog), so the
-- app works either way; applying this lets designations grant it in
-- Settings → Access & Roles.
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'clients', 'view', 'clients.view',
  'View clients module',
  'Open the Clients module: client list, per-client dashboard, outstanding balances and service pricing.',
  5
)
ON CONFLICT (key) DO NOTHING;
