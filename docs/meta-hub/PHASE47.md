# Meta Hub — Phases 4–7

Extends the Phase 0–3 foundation. No existing feature changed behaviour; all additive.

## Phase 4 — Meta Ads drill-down
- `src/lib/integrations/meta/ads.ts`: live account / ad-set / ad insights + demographic/placement breakdowns via the central v26 client (CPL, CTR, CPC, CPM, ROAS, leads, conversions). On-demand (no new tables); the existing campaign-level `ad_daily_metrics` sync is untouched.
- CPL/CTR/ROAS surfaced on the agency dashboard from the already-synced `ad_daily_metrics`.

## Phase 5 — Branded client reports
- `src/lib/integrations/meta/social-report.ts` + `GET /api/social/report?clientId&days[&download]`: a self-contained, Cirqle-branded HTML **Social & Marketing report** reusing each client's `client_branding` (colours, logo, white-label mode, footer). KPIs, reach/lead deltas, top content, lead-by-campaign, AI summary + recommendations. Renders in a tab; print-to-PDF for a PDF. Report buttons on the agency table and each account dashboard.

## Phase 6 — AI performance insights
- `src/lib/integrations/meta/ai-insights.ts`: Groq-backed (reuses `src/lib/ai/groq`), with a deterministic rule-based fallback when `GROQ_API_KEY` is unset. The model receives ONLY verified rollup facts — it never invents numbers; output separates **facts** from **AI interpretation**. Cached in `meta_insight_cache` (facts-hashed). Surfaced on the agency dashboard and inside every branded report.

## Phase 7 — Agency dashboard + alerts
- `src/lib/integrations/meta/aggregate.ts`: one batched cross-client rollup (social reach/views/engagement/followers, leads + deltas, ad spend/leads/CPL/CTR/ROAS, health, sync failures, reports pending) — the shared source for the dashboard, alerts, reports and AI.
- **Agency master dashboard** `/dashboard/agency`: totals strip, per-client table with deltas + health dots + report links, on-demand AI insights, alert management. Gated on `reports.view`.
- **Performance alerts** (`alerts.ts` + `performance_alert_rules`): configurable thresholds — high CPL, lead drop %, reach drop %, spend spike %, stale sync, ROAS below, CTR below. Evaluated in the daily `social-sync` cron; admins notified (deduped per client+metric+day). Seeded with sensible agency-wide defaults. Managed from the dashboard's Alerts drawer (`settings.manage_company`).
- Failed-post and sync-failure notifications were already wired in Phases 2–3.

## Migration
Apply **after** the Phase 0–3 set:
`supabase/migrations/20260812130000_meta_hub_phase47.sql` — `performance_alert_rules` (with seeded defaults) + `meta_insight_cache`. No new permissions (reuses `reports.view` + `settings.manage_company`).

## Verify
`tsc --noEmit` clean · privacy gate clean · 57 meta-hub unit tests pass (added `ai-insights.test.ts`).
Optional: set `GROQ_API_KEY` for real AI narratives (already used elsewhere in the app) — otherwise the rule-based fallback runs.
