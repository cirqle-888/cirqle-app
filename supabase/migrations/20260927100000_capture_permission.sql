-- AI Capture permission
--
-- AI Capture (/dashboard/capture, the header's AI Capture button) had no
-- permission of its own: any signed-in employee saw it and could run it, and
-- every paste is a paid AI call. `capture.use` now gates the page, the nav
-- item, both header/Requests buttons and the analyze* server actions.
--
-- Backfill keeps everyone who uses it today: admins, plus any designation
-- that can already act on what Capture produces — requests (requests.view),
-- ad campaigns (advertising.view) or offer flyers (offer.prepare, whose
-- holders run Capture in offer mode). A Designer holds none of these, so
-- Capture drops out of their sidebar. Grant it per designation in
-- Settings → Designations afterwards.

BEGIN;

INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('capture', 'use', 'capture.use', 'Use AI Capture',
    'Paste a WhatsApp message, email or product list and have AI draft it into a request, campaign or offer', 3)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT DISTINCT d.id, cap.id, TRUE
  FROM public.designations d
  CROSS JOIN public.permissions cap
 WHERE cap.key = 'capture.use'
   AND (
     d.is_admin = TRUE
     OR EXISTS (
       SELECT 1
         FROM public.designation_permissions dp
         JOIN public.permissions p ON p.id = dp.permission_id
        WHERE dp.designation_id = d.id
          AND dp.allowed = TRUE
          AND p.key IN ('requests.view', 'advertising.view', 'offer.prepare')
     )
   )
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
