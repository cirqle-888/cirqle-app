# Cirqle Social & Marketing Hub — Meta Integration (Phases 0–3)

Implementation report. Built on the existing advertising/social foundation — **no rebuild**; existing functionality preserved.

## What shipped

### Phase 0 — Foundation & hardening
- **Central Graph API client** (`src/lib/integrations/meta/client.ts`): single pinned `META_API_VERSION` (**v26.0**, replacing the sunset v19.0 that was hardcoded in 9 places), `appsecret_proof` on every call, normalized `MetaApiError` (auth vs rate-limit classification), exponential-backoff retries, cursor pagination (`metaGraphAll`), token redaction, and `exchangeForLongLivedToken`.
- **Token encryption at rest** (`src/lib/integrations/tokens.ts`): AES-256-GCM. Legacy plaintext rows are read transparently and re-encrypted on next write. Key: `META_TOKEN_ENCRYPTION_KEY`.
- **Working Meta token refresh**: `MetaProvider.refreshTokenIfNeeded` + `refreshToken` now re-exchange the long-lived token; `token.ts` worker decrypts/encrypts and marks dead connections `expired`. The `token-refresh` cron is now **registered in `vercel.json`** (it never ran before).
- **`ad_events` bug fixed**: inserts now use the real columns (`actor_id`, `detail`) — every provider/sync event was silently failing to record.
- **RLS lockdown**: `provider_connections` migration enables RLS with **zero policies** (service-role only) — it was publicly anon-readable with plaintext tokens per `docs/db-state.md`.
- **Webhook endpoint** (`src/app/api/webhooks/meta/route.ts`): GET handshake + POST with `X-Hub-Signature-256` HMAC validation; idempotent `webhook_events` log. Middleware exempts `/api/webhooks/`.

### Phase 1 — Social accounts & insights
- OAuth scope set widened to Pages + Instagram + leads (`META_OAUTH_SCOPES`); callback discovers Pages + linked IG accounts and records granted scopes.
- Tables: `social_accounts`, `social_account_insights_daily`, `social_media_items`.
- Insights sync (`insights.ts`) using **2026 metric names** (`views` canonical; FB `page_media_view`/`page_total_media_view_unique`; IG `views`/`reach`/`total_interactions`/`accounts_engaged`/`profile_links_taps`). Each metric group degrades independently (Meta keeps pruning metrics).
- **Social Hub** landing (`/dashboard/social`), **per-account dashboard** with previous-period % comparison + charts + top posts/reels/stories, and a **client-detail social panel**.

### Phase 2 — Content publishing
- Table `social_posts` + public `social-media` storage bucket (Meta fetches media by URL).
- Platform validation (`src/lib/social-hub/validation.ts`) encoding verified 2026 limits; the composer disables submit on any error and shows warnings (e.g. IG Stories are publish-only).
- Publisher (`publish.ts`): IG container flow (feed/carousel/**Reels**/**Stories**, first comment), FB feed/photo/multi-photo/video/Reels. Status-CAS claim prevents double-publish.
- **Content calendar** (`/dashboard/social/calendar`) with month/list views + composer; `social-publisher` cron every 10 min (IG has no native scheduling — this queue *is* the scheduler).

### Phase 3 — Meta Lead Ads → CRM
- **New leads CRM** (Cirqle had none): `leads`, `lead_forms`, `lead_automation_rules`.
- Real-time `leadgen` webhook + 90-day backfill polling; dedup on `(source, external_lead_id)`.
- Normalization, attribution capture (campaign/adset/ad/form), configurable automation rules (assign / create task / notify), new notification types.
- **Leads UI** (`/dashboard/leads`): pipeline table, detail drawer with raw form answers, add-lead, automation-rule editor.

## Verification
- `npx tsc --noEmit` — **clean**.
- Employee-name privacy gate — **no leaks**.
- New unit tests — **54 passing** (tokens, validation, webhook signature, lead normalization, Graph client).
- Full suite — 842 passing. 9 failures are **pre-existing** in `contributions/actions.test.ts` (it doesn't mock `next/cache`; unrelated to this work).

## Known limitations / follow-ups
- **App Review**: external-client OAuth needs Business Verification + Advanced Access on the pages/instagram/leads scopes. In dev mode everything works only for users with a role on the Meta app. See `SETUP.md`.
- **Rotate existing Meta tokens** after applying the foundation migration — old plaintext values must be treated as leaked (disconnect + reconnect each provider).
- FB Page Stories, comment/DM inbox, and write-back campaign management are intentionally out of scope (Phase 4+).
- The older `/dashboard/social-calendar` planner (feeds Requests) is untouched and coexists with the new publishing calendar.
