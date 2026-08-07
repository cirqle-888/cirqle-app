-- Plugin operational events (Phase 9 — Plugin Health panel).
--
-- Lightweight observability for Cirqle Studio: what offer_change_logs can't
-- carry (auth failures, update-required refusals, transport-level failures,
-- durations). Written best-effort by the /api/figma/* routes — a logging
-- failure never fails the request. Read on demand by the admin "Plugin
-- health" panel (Apps → Offer Intake); no pre-aggregation.
--
-- Retention: pruned to ~180 days by the existing cleanup cron.

create table if not exists figma_events (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in (
                   'save_ok', 'save_conflict', 'save_failed',
                   'image_upload_ok', 'image_upload_failed',
                   'auth_failed', 'update_required'
                 )),
  campaign_id    uuid,           -- no FK: events must outlive deleted campaigns
  plugin_version text,
  plugin_build   text,
  platform       text,
  duration_ms    int,
  detail         text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_figma_events_kind_time on figma_events(kind, created_at desc);
create index if not exists idx_figma_events_time on figma_events(created_at desc);
