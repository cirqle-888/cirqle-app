-- One-time backfill: mirror existing client_product_catalog rows (products
-- clients have already submitted through Offer Intake) into the global
-- product_catalog, so they show up on /dashboard/catalog. Going forward,
-- saveCampaign() (src/app/intake/offer/[token]/actions.ts) mirrors new
-- submissions automatically — this migration only catches up on history.
--
-- product_catalog is shared across all clients (deduped by name, case-
-- insensitive); client_product_assignments tracks which clients use which
-- global product. Idempotent — safe to re-run.

insert into product_catalog (name, weight, image_url)
select distinct on (lower(trim(cpc.name)))
  trim(cpc.name), cpc.weight, cpc.image_url
from client_product_catalog cpc
where not exists (
  select 1 from product_catalog pc where lower(trim(pc.name)) = lower(trim(cpc.name))
)
order by lower(trim(cpc.name)), cpc.created_at asc;

insert into client_product_assignments (client_id, product_id, is_active)
select cpc.client_id, pc.id, true
from client_product_catalog cpc
join product_catalog pc on lower(trim(pc.name)) = lower(trim(cpc.name))
on conflict (client_id, product_id) do nothing;
