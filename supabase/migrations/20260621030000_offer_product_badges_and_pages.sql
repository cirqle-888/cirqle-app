-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Multi-badge + multi-page support for offer products                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Multi-badge: a product can carry several badges (predefined and/or free-text
-- custom labels), replacing the single offer_products.badge_id (column kept,
-- now unused going forward, for backward-compat safety).
create table if not exists offer_product_badges (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references offer_products(id) on delete cascade,
  badge_id      uuid references offer_badges(id) on delete set null,
  custom_label  text,
  color         text not null default 'amber',
  display_order int not null default 0,
  created_at    timestamptz not null default now(),
  constraint offer_product_badges_label_chk check (badge_id is not null or custom_label is not null)
);
create index if not exists idx_offer_product_badges_product on offer_product_badges(product_id);

-- Backfill existing single-badge assignments so nothing is lost.
insert into offer_product_badges (product_id, badge_id, color, display_order)
select op.id, op.badge_id, coalesce(ob.color, 'amber'), 0
from offer_products op
join offer_badges ob on ob.id = op.badge_id
where op.badge_id is not null
  and not exists (select 1 from offer_product_badges opb where opb.product_id = op.id);

-- Multi-page offers: which page of the flyer this product belongs to (1-based).
alter table offer_products add column if not exists page int not null default 1;
