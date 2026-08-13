# Meta Hub — Setup & Go-Live Checklist

## 1. Apply migrations (Supabase SQL editor, in this order)
Per repo convention, migrations are pasted manually — never auto-applied.

1. `supabase/migrations/20260812110000_meta_hub_foundation.sql`
   - Adds token metadata columns to `provider_connections`, **locks it down with RLS (service-role only)**, creates `webhook_events`.
2. `supabase/migrations/20260812113000_social_accounts.sql`
   - `social_accounts`, `social_account_insights_daily`, `social_media_items` + `social.connect` / `social.view_insights` permissions.
3. `supabase/migrations/20260812120000_social_posts.sql`
   - `social_posts` + public `social-media` storage bucket + `social.publish` / `social.approve` permissions.
4. `supabase/migrations/20260812123000_leads_crm.sql`
   - `leads`, `lead_forms`, `lead_automation_rules` + `leads.view` / `leads.manage` permissions.

After applying #1: **rotate Meta tokens** — go to `/dashboard/advertising/integrations`, disconnect each Meta connection and reconnect. The old plaintext tokens in the DB must be treated as compromised.

Verify: `node scripts/check-pending-migrations.mjs`.

## 2. Environment variables (Vercel)
Existing: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_LOGIN_CONFIG_ID` (if Facebook Login for Business), `OAUTH_STATE_SECRET`, `CRON_SECRET`.

New:
- `META_TOKEN_ENCRYPTION_KEY` — 32-byte key (base64 or 64-char hex) for token encryption at rest. If unset it derives from `SUPABASE_SERVICE_ROLE_KEY`, but set a dedicated key in production so crypto and DB creds rotate independently. Generate: `openssl rand -hex 32`.
- `META_WEBHOOK_VERIFY_TOKEN` — any random string; the same value goes in the Meta App Dashboard webhook config.
- Optional: `META_API_VERSION` (defaults to `v26.0`).

## 3. Meta App Dashboard
1. **Webhooks** → add the **Page** topic, callback URL `https://<app>/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Subscribe at least the `leadgen` field (also `feed` if desired). Per-Page subscription is done automatically after OAuth by `subscribePageWebhooks()`.
2. **Login configuration** (Facebook Login for Business) — set `META_LOGIN_CONFIG_ID` and add every permission the hub uses (see `META_OAUTH_SCOPES` in `src/lib/advertising/providers/meta.ts`): pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_metadata, pages_manage_ads, read_insights, publish_video, instagram_basic, instagram_manage_insights, instagram_content_publish, instagram_manage_comments, leads_retrieval, ads_read, ads_management, business_management.
3. Each client Page must accept the **Lead Ads Terms of Service** once (facebook.com/ads/leadgen/tos) or lead retrieval fails.

## 4. Access levels (important)
- **Dev mode (no App Review):** every feature works, but only for Pages/IG/ad accounts owned by people who have a **role** on your Meta app (admin/developer/tester). Use this to demo and validate end-to-end.
- **Serving real external clients:** requires **Business Verification** + **App Review / Advanced Access** on the pages_*, instagram_*, and leads_retrieval scopes. Build and test in dev mode first, then submit the whole permission bundle in one review with a working screencast.

## 5. Crons (already added to vercel.json)
- `token-refresh` daily 05:30 UTC — re-exchanges tokens within 7 days of expiry.
- `social-sync` daily 02:30 UTC — insights + media + lead backfill.
- `social-publisher` every 10 min — publishes due scheduled posts (publish accuracy = this cadence).

## 6. Grant permissions
In Settings → Designations, grant `social.view_insights`, `social.connect`, `social.publish`, `social.approve`, `leads.view`, `leads.manage` to the relevant designations (admins already have everything).
