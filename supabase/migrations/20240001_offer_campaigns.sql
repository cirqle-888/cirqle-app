-- ============================================================
-- Cirqle Offer Campaign System
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Offer badges (managed from Settings)
create table if not exists offer_badges (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  color       text not null default 'amber',   -- tailwind color name: amber, red, green, blue, purple
  display_order int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into offer_badges (label, color, display_order) values
  ('Big Deal',    'red',    1),
  ('Wow Offer',   'amber',  2),
  ('Hot Price',   'orange', 3),
  ('New Arrival', 'green',  4),
  ('Best Value',  'blue',   5),
  ('Clearance',   'purple', 6)
on conflict do nothing;

-- 2. Per-client product catalog (grows over time)
create table if not exists client_product_catalog (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  name        text not null,
  weight      text,                -- e.g. "1kg", "500ml"
  image_url   text,                -- public URL (Supabase Storage)
  category    text,                -- e.g. "Dairy", "Vegetables"
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_product_catalog_client on client_product_catalog(client_id);

-- 3. Offer campaigns (one per flyer run)
create table if not exists offer_campaigns (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  offer_token     text not null unique default replace(gen_random_uuid()::text, '-', ''),
  title           text,                         -- client's suggested offer title
  date_type       text not null default 'range' check (date_type in ('single', 'range')),
  offer_date      date,                         -- used when date_type = 'single'
  offer_date_from date,                         -- used when date_type = 'range'
  offer_date_to   date,                         -- used when date_type = 'range'
  status          text not null default 'active' check (status in ('active', 'finalised', 'archived')),
  sheet_last_synced_at timestamptz,
  sheet_sync_error     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_campaigns_client on offer_campaigns(client_id);

-- 4. Products in a campaign (snapshot of catalog + offer details)
create table if not exists offer_products (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references offer_campaigns(id) on delete cascade,
  catalog_id      uuid references client_product_catalog(id) on delete set null,
  name            text not null,
  weight          text,
  image_url       text,
  offer_type      text not null default 'price' check (offer_type in ('price', 'percent', 'bogo', 'other')),
  price           numeric(10,2),                -- sale price (offer_type = price)
  mrp             numeric(10,2),                -- original price (optional)
  offer_text      text,                         -- "50% Off" / "Buy 1 Get 1" / custom
  badge_id        uuid references offer_badges(id) on delete set null,
  display_order   int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_offer_products_campaign on offer_products(campaign_id);

-- 5. Change log (auto-generated on every client save)
create table if not exists offer_change_logs (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references offer_campaigns(id) on delete cascade,
  log_type        text not null check (log_type in ('product_added', 'product_removed', 'product_changed', 'header_changed', 'client_note', 'system')),
  product_id      uuid references offer_products(id) on delete set null,
  product_name    text,                         -- snapshot in case product deleted
  field           text,                         -- which field changed
  old_value       text,
  new_value       text,
  note            text,                         -- for client_note type
  acknowledged    boolean not null default false,
  acknowledged_by uuid references employees(id) on delete set null,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_change_logs_campaign on offer_change_logs(campaign_id);
create index if not exists idx_change_logs_unacked  on offer_change_logs(campaign_id, acknowledged) where acknowledged = false;

-- 6. Add sheet webhook URL + offer token to clients table (Apps Script approach — no Google Cloud credentials needed)
do $$ begin
  alter table clients add column if not exists offer_sheet_webhook_url text;
  alter table clients add column if not exists offer_intake_token text unique default replace(gen_random_uuid()::text, '-', '');
exception when others then null;
end $$;

-- Backfill offer_intake_token for existing clients that don't have one
update clients set offer_intake_token = replace(gen_random_uuid()::text, '-', '') where offer_intake_token is null;

-- ============================================================
-- Storage bucket for product images
-- Run separately in Supabase Dashboard > Storage if needed:
--   Bucket name: product-images
--   Public: true
-- ============================================================
