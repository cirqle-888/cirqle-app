-- Add offer flyer service flag to clients
-- Enables the full offer campaign + product catalog module for specific clients
alter table clients
  add column if not exists has_offer_flyer_service boolean not null default false;

-- Index so we can quickly filter to enabled clients
create index if not exists clients_offer_flyer_service_idx
  on clients (has_offer_flyer_service)
  where has_offer_flyer_service = true;
