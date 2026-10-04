-- Retire the in-app offer intake (offers are prepared in Offer Studio)
--
-- Since Sep 2026 every offer reaches Cirqle from Offer Studio
-- (flyer.cirqle.work), a separate app that pushes saved offers through
-- /api/figma/campaign. The in-app Offer Prepare workspace, the Offer Intake
-- settings and the client offer form were removed from the code in the same
-- change as this file. Two permission rows follow from that:
--
--   offer.prepare  keeps working, but now only gates the offer-flyer product
--                  catalog — relabelled so the Designations screen says so.
--   capture.use    was backfilled (20260927100000) to designations holding
--                  offer.prepare so flyer staff could use AI Capture's offer
--                  mode. That mode is gone; a designation that got capture.use
--                  ONLY through offer.prepare (no requests.view, no
--                  advertising.view, not admin) loses it again. Today that is
--                  Flyer Designer.
--
-- No data is deleted: offer campaigns, products, catalog and clients'
-- offer_intake_token columns are untouched.

BEGIN;

UPDATE public.permissions
   SET label = 'Manage offer product catalog',
       description = 'Review and manage the offer-flyer product catalog. Offer lists themselves are prepared in Offer Studio.'
 WHERE key = 'offer.prepare';

DELETE FROM public.designation_permissions dp
 USING public.permissions cap, public.designations d
 WHERE dp.permission_id = cap.id
   AND cap.key = 'capture.use'
   AND d.id = dp.designation_id
   AND d.is_admin IS NOT TRUE
   AND EXISTS (
     SELECT 1 FROM public.designation_permissions x JOIN public.permissions p ON p.id = x.permission_id
      WHERE x.designation_id = d.id AND x.allowed AND p.key = 'offer.prepare')
   AND NOT EXISTS (
     SELECT 1 FROM public.designation_permissions x JOIN public.permissions p ON p.id = x.permission_id
      WHERE x.designation_id = d.id AND x.allowed AND p.key IN ('requests.view', 'advertising.view'));

COMMIT;
