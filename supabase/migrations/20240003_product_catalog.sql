-- ============================================================
-- Cirqle Global Product Catalog
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Global product catalog (shared across all clients)
create table if not exists product_catalog (
  id            uuid primary key default gen_random_uuid(),
  -- Human-readable Product ID (PRD-XXXXXXXX) — immutable, used for linking
  product_code  text unique not null default ('PRD-' || upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  name          text not null,
  weight        text,
  category      text,
  brand         text,
  barcode       text,
  -- Primary image URL (convenience shortcut — full versions in product_catalog_images)
  image_url     text,
  status        text not null default 'active' check (status in ('active', 'inactive')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists product_catalog_name_idx      on product_catalog (lower(name));
create index if not exists product_catalog_category_idx  on product_catalog (category);
create index if not exists product_catalog_brand_idx     on product_catalog (brand);
create index if not exists product_catalog_barcode_idx   on product_catalog (barcode);
create index if not exists product_catalog_status_idx    on product_catalog (status);

-- 2. Product images — multiple versions per product
create table if not exists product_catalog_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references product_catalog(id) on delete cascade,
  version      text not null default 'original'
                 check (version in ('original', 'bg_removed', 'flyer_ready', 'thumbnail')),
  url          text not null,
  storage_path text,  -- path in Supabase Storage (for deletion)
  source       text not null default 'upload'
                 check (source in ('upload', 'url', 'google_drive')),
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists product_catalog_images_product_idx on product_catalog_images (product_id);

-- Ensure only one primary image per product
create unique index if not exists product_catalog_images_primary_idx
  on product_catalog_images (product_id)
  where is_primary = true;

-- 3. Client-product assignments (which clients use which global products)
create table if not exists client_product_assignments (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  product_id     uuid not null references product_catalog(id) on delete cascade,
  -- Optional client-specific overrides
  custom_name    text,
  custom_weight  text,
  custom_image_id uuid references product_catalog_images(id) on delete set null,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, product_id)
);

create index if not exists client_product_assignments_client_idx  on client_product_assignments (client_id);
create index if not exists client_product_assignments_product_idx on client_product_assignments (product_id);

-- 4. Keep existing client_product_catalog for backward compat
--    New code will prefer product_catalog + client_product_assignments
--    but existing client-specific products remain accessible

-- 5. Helper: auto-update updated_at on product_catalog
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists product_catalog_updated_at on product_catalog;
create trigger product_catalog_updated_at
  before update on product_catalog
  for each row execute function set_updated_at();

drop trigger if exists client_product_assignments_updated_at on client_product_assignments;
create trigger client_product_assignments_updated_at
  before update on client_product_assignments
  for each row execute function set_updated_at();

-- ============================================================
-- Storage bucket for product images (run separately if needed)
-- ============================================================
-- insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
-- on conflict do nothing;
