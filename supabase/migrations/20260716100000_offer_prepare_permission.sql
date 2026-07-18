-- Internal Offer Preparation (/dashboard/offer-prepare) — dedicated permission.
-- Pre-migration the route only checked "is signed in", so any logged-in
-- employee could prepare offers. Applying this makes it grantable per
-- designation in Settings → Access & Roles (admins bypass the catalog).
--
-- ⚠️ After applying: grant 'offer.prepare' to any NON-admin designation that
-- prepares offer flyers, or those employees lose access to the route.
INSERT INTO public.permissions (module, action, key, label, description, display_order)
VALUES (
  'offer', 'prepare', 'offer.prepare',
  'Prepare offer flyers',
  'Open the internal Offer Preparation workspace: pick a client, paste their offer list, review products and generate the designer Google Sheet.',
  6
)
ON CONFLICT (key) DO NOTHING;
