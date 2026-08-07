-- Campaign version history (Phase 8 of the Cirqle Studio restructuring).
--
-- One row per meaningful save (products changed): a self-contained jsonb
-- snapshot of the campaign header + full products array with badges — the
-- same shape CampaignInput carries — so old revisions survive offer_products
-- schema drift. Admins can inspect and restore from the campaign card;
-- every restore first snapshots the current state (automatic backup), so
-- restores are always reversible.
--
-- SHIPS DARK: writes happen only when company_settings
-- feature_offer_revisions = 'on' (default off). Applying this migration
-- changes nothing by itself.
--
-- Retention: capped at the most recent 30 revisions per campaign (enforced
-- in code on insert).

create table if not exists offer_campaign_revisions (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references offer_campaigns(id) on delete cascade,
  revision_no  int  not null,
  snapshot     jsonb not null,
  actor_kind   text not null default 'client'
                 check (actor_kind in ('client', 'staff', 'figma', 'restore')),
  actor_id     uuid references employees(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now(),
  unique (campaign_id, revision_no)
);

create index if not exists idx_offer_revisions_campaign
  on offer_campaign_revisions(campaign_id, revision_no desc);
