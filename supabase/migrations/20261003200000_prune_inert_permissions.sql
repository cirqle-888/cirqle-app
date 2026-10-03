-- Permission switches that matched no feature, and one feature with no switch
--
-- A 2026-10-03 audit compared every row in public.permissions with the code.
-- Five rows on the Designations screen are enforced NOWHERE — turning them on
-- or off changes nothing, so the screen claims control it does not have:
--
--   tasks.export               there is no task export
--   billing.view_pricing       superseded by tasks.view_pricing (the enforced one)
--   workspace.access           My Planner is open to every signed-in employee by
--                              design (see dashboard/workspace/page.tsx)
--   chat.client_conversations  no client-portal chat exists
--   recruitment.interview      interviewer assignment was never built
--
-- The reverse: the Connections page (sidebar + middleware) requires
-- advertising.manage_providers, which was never inserted — so no designation
-- could ever be granted it and only admins could open the page. Admins keep it;
-- it can now be granted to others.
--
-- Note: offer.manage_groups is also unenforced but is NOT removed here — it is
-- granted to Flyer Designer by hand, and wiring it opens an admin-only page that
-- shows the Apps Script shared secret, so that needs a decision first.

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('advertising', 'manage_providers', 'advertising.manage_providers', 'Manage Ad Connections',
    'Open Connections: connect or disconnect Meta and Google ad accounts and manage their access tokens', 80)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE AND p.key = 'advertising.manage_providers'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

DELETE FROM public.designation_permissions
 WHERE permission_id IN (
   SELECT id FROM public.permissions
    WHERE key IN ('tasks.export', 'billing.view_pricing', 'workspace.access',
                  'chat.client_conversations', 'recruitment.interview'));

DELETE FROM public.permissions
 WHERE key IN ('tasks.export', 'billing.view_pricing', 'workspace.access',
               'chat.client_conversations', 'recruitment.interview');

COMMIT;
