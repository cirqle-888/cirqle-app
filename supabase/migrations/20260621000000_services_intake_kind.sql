-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Service-based intake routing                                              ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║  Each service declares which client-facing intake/request form it exposes. ║
-- ║  A client's available forms are DERIVED from the intake_kinds of the       ║
-- ║  services assigned to them (client_service_pricing) — no separate          ║
-- ║  client-module table. This replaces the one-off clients.has_offer_flyer_   ║
-- ║  service boolean with scalable, service-driven capability.                 ║
-- ║                                                                            ║
-- ║  Free-text (no CHECK) so future kinds (meta_ads, google_ads, website, seo) ║
-- ║  need NO migration — they're validated in app code                         ║
-- ║  (src/lib/services/intake.ts).                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table services
  add column if not exists intake_kind text not null default 'none';

comment on column services.intake_kind is
  'Client-facing intake form this service exposes: none | request_portal | offer_intake | <future>. A client''s forms are derived from the services assigned to them via client_service_pricing.';

-- Backfill: tag the existing offer-flyer services so supermarket clients keep
-- their Offer Intake workflow with no manual re-tagging. Everything else stays
-- 'none' until an admin tags it in Settings → Services.
update services
   set intake_kind = 'offer_intake'
 where intake_kind = 'none'
   and (name ilike '%offer flyer%' or name ilike '%a3 offer%');
