-- Public storage bucket for offer-product images, uploaded by clients through
-- the Offer Intake form (src/app/intake/offer/[token]/actions.ts:getImageUploadUrl).
--
-- Without this bucket, signed-upload-URL creation fails server-side; the
-- client silently no-ops (no image_url ever gets set), which is why product
-- images never reached the campaign review, the Requests inbox, or the
-- Google Sheet sync.
--
-- All writes go through the service-role admin client (server actions), so no
-- storage.objects RLS policies are needed here — the bucket only needs to
-- exist and be public for GET access to the uploaded images.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;
