# Ads reporting — evidence register

Tracks the issues in *Cirqle Ads Reporting Implementation Plan v1.0*
(24 Oct 2026) against this checkout. Every status is backed by code and a
test. Nothing has been deployed or committed; browser checks were read-only
previews (see each batch's notes).

## Batch B — 25 Oct 2026 (local, uncommitted)

**After:** 216 files / 2947 passed (+4 files, +18 tests); typecheck clean;
`npm run lint` 0 errors, 2120 warnings (cap 2128). No migration: the
`messages`, `purchases` and `landing_page_views` columns already exist
(`20260628120000_advertising_module.sql`).

| ID | Status | What changed | Evidence |
| --- | --- | --- | --- |
| AUD-01 reach summed | **Fixed in code, unverified live** | New `getCampaignPeriodReach` on the provider interface. Meta asks insights for the range with no `time_increment`, so people are de-duplicated. `period-reach.ts` fetches it when a report is built; any failure returns a reason, never a number. Headlines use unique reach when available, otherwise "Reach (sum)". The monthly table column reads "Reach (sum)". The reach delta is only computed between two unique figures. Excel/CSV list both. | `headline-reach.test.ts`, `result-type.test.ts › reach delta` |
| AUD-03 action types | **Fixed in code, unverified live** | `meta-actions.ts` maps conversations (`onsite_conversion.messaging_conversation_started_7d`), purchases (first of `omni_purchase` → `purchase` → `offsite_conversion.fb_pixel_purchase`, never summed) and landing-page views. Sync and ingest store them. Result definition v2: messages → conversations, sales/conversion/remarketing → purchases. | `meta-actions.test.ts`, `result-type.test.ts` (₹500 / 10 conversations = ₹50) |
| AUD-05 zero vs missing | **Fixed** | Rows have nullable messages/purchases/LPVs. A period that never recorded the result metric shows "not available", and partial coverage is reported (`resultCoverage`). No rows at all → results null, not 0. | `result-type.test.ts` |
| AUD-18 freshness/completeness | **Partly fixed** | `data-quality.ts` separates zero-delivery days (row with no spend) from missing days (no row), clipped to campaign dates and today, and flags a partial today. Shown as a note in the daily/monthly PDF, web viewer, email and AI text. Sync jobs accept `start_date`/`end_date` (≤ 400 days) for backfill. Not done: nothing enqueues a backfill yet, and generation is not blocked on stale data. | `data-quality.test.ts`, `sync-range.test.ts` |
| AUD-04 health (follow-up) | **Fixed** | A grade now needs a performance signal; a campaign judged on pacing alone is "not graded". | `pacing.test.ts` |

Wording fix found in live preview: utilisation is to-date, so the summary now says "₹X spent in this period; Y% of the allocation used to date". It used to say "₹0 of the ₹2,000 budget (100% utilised)". Card and export labels now read "Allocation used to date".

### Live check (read-only previews, production data)

- 4 campaigns, last 30 days: two show "No data was synced for 30 of 30 days". The other two expect 0 days (campaign dates outside the range). All are "not graded".
- Mezza 20% Offer, July: 9/9 days recorded, awareness, so no CPR. Health was "A 100/100" from pacing alone, which led to the follow-up fix above.
- **Period reach and the new Meta actions were not exercised:** only 1 of 4 campaigns is linked to a Meta connection, and it has never synced (0 rows). Running a sync would write to production, so it wasn't done.
- The linked campaign "Sea Star … WhatsApp Leads" has objective `leads`. If it is a click-to-WhatsApp campaign, set it to `messages` so conversations count.

### Live sync — 25 Oct 2026 (authorised; wrote to production)

"Sync Now" on Sea Star Restaurant | Wedding Package | WhatsApp Leads (`973a688a…`).
This ran 2 sync jobs: the one waiting since the campaign was created, plus the
manual one. Both succeeded, and the no-op notification jobs completed. Rows written (source `meta API`):

| Date | Spend | Impr. | Reach | Clicks | Leads | Conversations | Purchases | LPV |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-24 | ₹169.48 | 3,233 | 2,950 | 70 | 0 | 2 | 0 | 0 |
| 2026-10-25 (partial) | ₹0.02 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

Preview 24–25 Oct: **period reach 2,950 unique** (frequency 1.096, from Meta;
the daily sum is 2,951). Coverage is 2/2 days, with today flagged partial.

#### Reconciled with Ads Manager — 24 Oct 2026

Ads Manager: campaign 120250442854960762, account timezone Asia/Kolkata,
date 24 Oct 2026, attribution "7-day click or 1-day view" (the account
default; the sync does not override it).

| Metric | Cirqle (synced) | Ads Manager | Match |
| --- | --- | --- | --- |
| Amount spent | ₹169.48 | ₹169.48 | ✓ |
| Impressions | 3,233 | 3,233 | ✓ |
| Reach | 2,950 | 2,950 | ✓ |
| Clicks (all) | 70 | 70 | ✓ (link clicks are 50) |
| Messaging conversations started | 2 | 2 (Results) | ✓ |
| Cost per conversation | ₹84.74 (169.48 ÷ 2) | ₹84.74 | ✓ |

For a single day, daily reach and period reach are the same number. The
de-duplication across days (2,950 unique vs 2,951 summed for 24–25 Oct) comes
from the same Meta call and was not checked against a multi-day Ads Manager
range, because 25 Oct had 1 impression.

- **Still unverified:** the purchase mapping (no purchases on this account in range) and a multi-day reach comparison.
- **Account status (seen in Ads Manager):** "You ran out of prepaid funds"; the campaign's delivery is *Payment error*, which is why 25 Oct shows ₹0.02. Nothing was changed there.
- **Objective corrected (25 Oct, at the user's request):** `campaign_type` changed from `leads` to `messages` on `ad_projects` and on its `ad_campaigns` mapping row, with an `ad_events` "updated" entry. This is the same change `updateAdProject` makes. It was done directly because no screen offers it: the mapping page shows the type read-only for mapped campaigns, and the campaign page only edits dates. The preview for 24 Oct now shows Conversations 2 and cost per conversation ₹84.74, matching Ads Manager. The rule-based narrative now speaks in the campaign's own result, and it no longer says "performing well" or "improve delivery pace" for an ungraded campaign with no allocation.
- To read clicks, the Ads Manager column preset was briefly switched to "Performance and clicks 2", then restored to "Performance".

### Before relying on Batch B in production

1. Run a sync (or backfill) for a linked Meta campaign, then compare conversations, purchases and period reach with Ads Manager for the same dates and attribution setting.
2. Backfill older periods: rows synced earlier have NULL messages/purchases, so those reports show "not recorded".

## Batch 1 — 25 Oct 2026 (local, uncommitted)

**Baseline before changes:** `vitest run` 206 files / 2881 passed; typecheck clean.
**After:** 212 files / 2929 passed (+6 files, +48 tests); typecheck clean;
`npm run lint` 0 errors, 2117 warnings (cap 2128); `lint:privacy` clean.

| ID | Status | What changed | Evidence |
| --- | --- | --- | --- |
| AUD-01 reach summed | **Open** | Not fixed. The AI prompt now says reach is a sum of daily reach. Fixing it means fetching period-level reach from Meta (Batch B). | — |
| AUD-02 CPR fallback | **Fixed** | `result-type.ts`: the result metric is picked once from `campaign_type` and never swapped for clicks. No results → CPR shown as `—`. | `result-type.test.ts` (₹500 / 0 leads / 50 clicks), `monthly-report.test.ts` (old click-fallback test now expects null) |
| AUD-03 missing action types | **Partly fixed** | Messages, installs and video views now report "not imported yet" instead of a wrong number. Meta's `actions` mapping still only reads `lead`. | `result-type.test.ts` |
| AUD-04 ROAS-weighted health | **Fixed** | `scoring.ts`: a component that can't be judged is left out of the score. ROAS and its forecast only count when revenue is tracked. Pacing uses time-aware expected spend (`pacing.ts`). Adds an `insufficientData` flag. | `pacing.test.ts` |
| AUD-05 zero vs missing | **Partly fixed** | CPR/CPL/CPC/CTR/ROAS show `—` or "Not tracked" in email, cards, daily/monthly layouts, web viewer, AI text. Deltas are null when not comparable. Data-engine rows still read missing columns as 0. | `result-type.test.ts`, `delivery-engine.test.ts` |
| AUD-06 balance date scope | **Fixed** | Only allocations made on or before `dateTo` count. Spend before `dateFrom` gives `openingBalance`. Remaining = opening − in-period cost. Old snapshots fall back to the previous behaviour. | `result-type.test.ts › balances` |
| AUD-07 "profit" | **Fixed (labels)** | Excel/CSV/AI now say "Revenue minus ad spend". The field name `profit` stays for stored snapshots. | — |
| AUD-08 benchmark provenance | **Fixed** | `getBenchmarksWithSource` returns the real tier. Placeholder (`global`) values are shown as such but never compared or graded against. | `pacing.test.ts` (health with no benchmark) |
| AUD-09 sections dropped | **Fixed** | `config.ts › parseReportRequest` is shared by preview and generate. | `config.test.ts` |
| AUD-10 HTTP 200 on failure | **Fixed** | `?sync=true` returns 502 for a failed report. Both forms warn when some formats or emails failed. | — |
| AUD-11 ready with no exports | **Fixed** | No exports → `failed`, nothing emailed. Some exports → `ready` with failed formats named in `error_message` (the status check has no `partial` value). | `orchestrator.test.ts` |
| AUD-12 7-day links | **Fixed** | `/download` re-checks permission, recovers the storage key from the stored URL (validated: same Supabase origin, `ad-reports` bucket, this report's folder) and signs a 10-minute URL. UI links use `?redirect=1`. Emailed links still expire after 7 days. | `delivery-engine.test.ts` |
| AUD-13 22 h queue wait | **Mitigated** | `report-scheduler` now processes the queue itself after enqueueing (240 s budget). Not fixed: the scheduler still runs once a day at 06:00 UTC, so a 07:00-UTC schedule waits until the next day's run. | — |
| AUD-14 next-run math | **Fixed** | `computeNextRun` handles timezones and the calendar, takes `now` for tests, and always returns a future time. The scheduler claims each schedule with a compare-and-set on `next_run_at`, and a missed period runs once. | `scheduler-utils.test.ts` (both plan reproductions, IST, DST, leap day) |
| AUD-15 email "delivered" | **Fixed** | Returned Resend errors are now failures. Acceptance stores the provider ID with `metadata.state = provider_accepted`. Missing config means every recipient failed. Interpolated text is HTML-escaped. **New finding:** attachments were passed as `{ url }`, which Resend ignores (the field is `path`), so no file was ever attached. | `delivery-engine.test.ts` |
| AUD-16 sync generation | **Open** | Forms still call `?sync=true`. | — |
| AUD-17 Google capability | **Open** | — | — |
| AUD-18 freshness gate | **Open** | — | — |
| AUD-19 FX silently 1:1 | **Fixed** | `pipeline.ts`: a row with no rate is refused and counted as failed, with an error naming the currency. | — |
| AUD-20 permissions/scope | **Fixed** | Generate needs `advertising.edit` via `requirePermission`, which also blocks it during view-as. Preview and download use `requireReadPermission`. The client always comes from the campaign row, and a mismatched `clientId` is refused (generate, preview, schedules). There is no per-client permission scope in the app to enforce beyond this. | `config.test.ts › resolveReportScope` |
| AUD-21 list limits | **Open** | — | — |
| AUD-22 composer/navigation | **Open** | — | — |

### Known gaps in this batch

- A failed report job is retried and each retry inserts a new `ad_reports` row (no stable report ID before queueing, Task 2B). Failed runs are never emailed, so this only adds extra failed rows to history.
- The analytics event is still named `email_delivered` because of the `ad_report_analytics_event_check` constraint. `metadata.state` holds what is actually known.
- The health grade can rest on pacing alone (e.g. a new awareness campaign on pace scores A). The `insufficientData` flag is only set when nothing at all can be judged.
- Pacing doesn't model pauses; there is no pause history to read.

### Not verified

- **Browser (partial, 25 Oct):** attached to the running dev server
  (`cirqle-app-attach`; a second `next dev` can't start for the same folder).
  The reports page and Generate form render. Preview of "Mezza - Brand
  Awareness" via the form: Revenue "Not tracked", ROAS/CPL/CTR/CPC "—", health
  flagged insufficient. That check found two bugs, both fixed: the
  insufficient-data case still showed grade **F**, and the web viewer
  showed ₹0 / 0.00x for unmeasurable metrics. The campaign had ₹0 spend in
  the period, so this is a thin case. Not checked: Generate (it writes to the
  production DB), downloads (no reports exist), and permission refusals
  (the dev permission bypass is on).
- **Exports:** no PDF/image was rendered and inspected.
- **Email:** only mocked; nothing was sent.
- **Production:** no migration applied, no deployment, no cron run.

### Rollback

All changes are code-only (no migrations). Reverting the files listed below restores the old behaviour. Report snapshots written by this code add optional fields (`openingBalance`, `priorSpend`, `derived.result`, `results`) that older readers ignore.

Files: `src/lib/reporting/{config,result-type,pacing}.ts` (new),
`scheduler-utils.ts`, `orchestrator.ts`, `delivery-engine.ts`, `data-engine.ts`,
`kpi-engine.ts`, `render-engine.ts`, `ai-engine.ts`, `types.ts`,
`layouts/{shared,daily-report,monthly-report,report-cards}.tsx`,
`exporters/{excel,csv}.ts`, `src/lib/advertising/ai/{scoring,benchmarks}.ts`,
`src/lib/advertising/pipeline.ts`, `src/lib/advertising/workers/reports.ts`,
`src/app/api/advertising/reports/{generate,preview,schedules,schedules/[id],[id]/download}/route.ts`,
`src/app/api/cron/report-scheduler/route.ts`, the two report forms and `WebReportViewer.tsx`.

## Next executable batch

B (remaining): period-level unique reach from Meta, Meta `actions` mapping for
conversations/purchases, zero-vs-missing day rows. Then C: stable report ID
before queueing, a `partial` status migration, per-format export rows, and moving the forms to
background generation.

## Batch C/E — 25 Oct 2026: stable runs and report workflow

**Local implementation only. The full implementation plan is not complete.**
Read the original saved v1.0 plan after the re-upload's text preview and local
transfer were unavailable. Preserved the existing uncommitted metric/finance work.

### Implemented in this batch

- **AUD-11 / Task 2B:** explicit `partial` generation status. Persist config,
  snapshot, per-format storage key/MIME/size and outcomes. Successful exports and
  the saved narrative are reused on retry. Persist progress before advancing;
  database-save errors cannot return a successful generation result.
- **AUD-16 / Task 2B:** one atomic SQL transaction creates a stable report ID and
  its job. Both forms submit in the background with a retained request key.
  The authenticated route wakes only the requested report job using Next.js
  `after`; the normal durable job queue remains the recovery mechanism.
- **Task 2D (partial):** accepted, failed and uncertain (`sending`) attempts are
  saved separately. No automatic resend of those attempts. Resend receives an
  idempotency key. Partial-format reports are downloadable but not automatically
  emailed. Legacy analytics events remain compatible and distinguish acceptance
  in metadata. Delivery webhooks and separate delivery retry are still outstanding.
- **Task 2C:** new exports save storage keys, MIME and sizes. Download authorization
  and validated legacy URL recovery remain in place. Partial reports can download
  successful files. Old report snapshots and URLs are retained.
- **Task 2E (partial):** scheduled queue creation uses a schedule/period/version
  key. Retry is atomic, reuses snapshots, and can recover a stale report worker.
  General job claiming stamps heartbeat time and respects retry timestamps;
  failure retries now back off instead of spinning immediately.
- **AUD-17:** Google connection UI explicitly says sync is unavailable and its
  OAuth entry point refuses new connections while no Google provider exists.
  Existing OAuth code and existing connections are retained for future completion.
- **AUD-21:** server-paginated history with campaign-name search and status filter.
  Complete campaign/schedule lists are read in bounded pages rather than silently
  stopping at 100/20. Campaign-list API pagination rejects zero/negative/NaN limits
  through bounded defaults. Historical routes remain compatible.
- **Task 5A (partial):** editable factual WhatsApp caption from the saved snapshot,
  Copy message and available PDF/image downloads on one screen. Nothing is sent.
  Unsupported result counts stay unavailable; reach sums are not called unique.
  Device-native file sharing and multi-image pagination are not added here.
- Fixed the interactive report page's synchronous Next.js route-parameter access.
  Pending/failed reports show progress/retry instead of a misleading 404.
  Report-hub permission now consistently requires `advertising.view_reports`.

### Database/deployment requirements

Apply `supabase/migrations/20261025100000_report_runs.sql` **before deploying this
code**. It adds compatible columns to `ad_reports`, expands its status check,
creates a unique request-key index, and adds service-role-only queue/retry RPCs.
No financial ledger rows are rewritten. No migration has been applied in this
session. No local PostgreSQL executable or staging database was available to
exercise the SQL transaction/RLS/concurrent-call scenarios.

The checked-in cron cadence is still daily. Immediate manual runs use `after`,
which is constrained by the platform's request duration; it is not an unlimited
background runtime. Stalled runs can be resumed from the report screen and the
existing cron can recover stale jobs. Frequent unattended retry/schedule delivery
still requires a verified production worker trigger and hosting capability.

Rollback: stop report workers/generation, restore the earlier reporting code, then
use `supabase/rollbacks/20261025100000_report_runs_down.sql`. It maps `partial` back
to legacy `ready` with a warning and removes only the RPCs/status extension;
config, snapshots and export/delivery evidence are retained.

### Outstanding plan work (do not mark complete)

- Preview approval and final export sharing one **approved** persisted version:
  retries now share a snapshot, but an ordinary preview still rebuilds separately.
- Mandatory sync-before-report/backfill dependency and critical data-quality gate;
  fuller attribution/timezone/FX and ledger reconciliation.
- ~~Client workspace/attention queue, one shared three-step composer, consolidated
  multi-campaign reports, client defaults~~ — done in the Phase 3–4 batch below.
  Still open: Malayalam summaries and their export visual verification.
- Secure expiring/revocable client links, approval/version lifecycle and delivery
  webhooks/recipient retry.
- Creative analysis, CRM enquiry quality, timeline annotations and budget approvals.
- Real Google provider plus permitted account reconciliation.
- Staging migration/concurrency checks, browser/mobile/accessibility QA, export
  visual QA, production triggers and controlled deployment.

No client messages, live ad changes, production migrations or deployments were
performed. Browser inventory timed out before any UI inspection.

## Phase 3–4 batch — 25 Oct 2026: client-first screens and the report composer

**Local, uncommitted.** Built on the Batch C/E queued-generation code (reused
`useReportSubmission`, `ReportProgress`, the share package), not a second system.
**After:** 223 files / 2991 tests passed; typecheck clean; lint 0 errors, 2121
warnings (cap 2128); privacy gate clean.

### What changed for people

| Area | Before | Now |
| --- | --- | --- |
| Advertising overview | Fixed tiles: Revenue ₹0, Avg ROAS 0.00×, Total Leads 0; no period; no alerts | Period selector (URL `?period=`); Spend + results **per objective** ("Conversations 2 · ₹94.67 each"); data-freshness tile; Revenue only when tracked; search box |
| Needs attention | — | Queue on the overview and each client: sync failed/stale/never, connection inactive/expiring, spend above allocation, **spending with nothing allocated**, active-but-not-spending (2 recorded zero days, never missing days), ending ≤3 days, failed reports/emails. Each has reason, owner (CQID only) and the action that fixes it |
| Campaign cards | ROAS · CTR · CPC · Leads for every objective | Objective-led: e.g. Conversations · Cost/conv. · Spend · CTR; awareness: Impressions · CPM; ROAS only with revenue; "Synced 9h ago" / "Manual data" |
| Client workspace (new) | — | `/dashboard/advertising/clients/[id]`: Overview · Campaigns · Funds & billing · Reports, same numbers as the overview |
| Campaign page | 7 tabs | 4: Overview (+ Activity = notes + timeline) · Performance · Funds & billing · Reports. Header: result + cost, dates, freshness, **Open in Ads Manager**, Meta status shown apart from Cirqle status; Integrations behind "Sync & connection". Old `?tab=daily/budget/notes/timeline/integrations` links still resolve |
| Report creation | Separate forms on two screens, 8 templates, single campaign | One **3-step composer** (hub, client workspace, campaign tab): client & campaigns → period & purpose (Quick update / Monthly client report / Detailed analysis; templates under Advanced) → preview with data checks → queue → share page |
| Client reports | — | 2+ campaigns of one client = one report; server re-checks one client; mixed objectives → per-campaign breakdown (viewer, Excel "Campaigns" sheet, CSV, AI prompt, WhatsApp caption), never one mixed total; unique reach not claimed across campaigns |

### Safety

- At that stage preview was read-only (superseded by the persisted approval snapshot below). Generate requires a fresh preview (stale settings flagged) and, when the period has **no data at all**, an explicit "Generate anyway".
- Email is sent only when "Email this report" is ticked for that send; saved recipients are shown, never used silently.
- Tab/period changes use `history.replaceState` (no server round trip).
- Coverage fix found in live preview: a campaign with no start date now counts from its first recorded day, so days before it existed are not "missing".

### Migrations — written, NOT applied (apply in order)

1. `20261025100000_report_runs.sql` (Batch C/E) — **report generation fails until applied** (`queue_ad_report` RPC; checked read-only: `ad_reports.config` does not exist yet).
2. `20261025180000_ad_attention_snoozes.sql` — until applied, alerts show but Snooze is hidden.
3. `20261025190000_ad_client_report_preferences.sql` — until applied, "Save as default for this client" is hidden; defaults come from the preset.

Each has a rollback in `supabase/rollbacks/`. No data is rewritten.

### Verified live (dev server, production data, read-only)

Overview, client workspace (all tabs), campaign page (4 tabs, legacy `?tab=daily`, Activity, Sync & connection), Reports hub `?client=` prefill, composer preview + data checks + no-data gate. No horizontal overflow at 375 px on overview, workspace and campaign page (a composer fieldset overflow was found and fixed). Nothing was generated, emailed or saved.

### Not done / not verified

- ~~Report generation end-to-end: blocked on migration 1~~ — verified 25 Oct after the migrations were applied (below).
- **Malayalam** summaries (preference column reserved; nothing produced).
- PDF/image layouts show a client report's combined numbers; the per-campaign breakdown is in the web view, Excel, CSV, AI text and caption, not yet in the PDF/image designs.
- Alert acknowledgement beyond snooze; alerts are computed on page load, not pushed.
- Meta delivery status on the campaign page is the status seen at campaign discovery (can lag); payment-level account issues (like the current "out of prepaid funds") are not detected.

## End-to-end report verification — 25 Oct 2026 (production, no email)

All three migrations confirmed in project `lgqarkdmlyfpacyqhfha` (read-only check).

**Route.** The composer ran preview → Generate in the browser, but the local dev server never finished compiling the generate route: the Mac was out of memory (14.5 of 15.4 GB swap used; the server process sat in disk wait). So the pipeline ran via Vitest instead, using the generate route's exact steps: shared validation and scope, the `queue_ad_report` RPC, `processReportJob`, exporters, storage upload, and fresh download signing. No recipients were given and no email was attempted. The temporary file was deleted.

**Bug found and fixed.** Every PDF and image export failed with "Image source must be an absolute URL: storage:company-branding/…". The company background images are stored as `storage:` references. `render-engine.ts` now resolves them (`resolveBrandingUrl`) and embeds them as data URIs, dropping any that can't be fetched. `layouts/shared.tsx › rasterSrc` skips unloadable sources, so older snapshots still render on retry. The pipeline reported both outcomes correctly: `failed` when no file was produced, `partial` when only Excel was. Neither was mislabelled as ready.

**Two coverage/wording fixes from the client report.**
- A campaign with no start date and no data now counts from the day it was created. Mezza – Brand Awareness, created 12 Aug, was being counted as missing all of July.
- The client-report summary now reads "Across 3 … campaigns … their combined allocation".

| Report | Status | Files (downloaded via fresh signed URL) | Key numbers |
| --- | --- | --- | --- |
| `2e63987d` Sea Star, quick update, 18–24 Oct | ready | image 286 KB, PDF 399 KB | 2 conversations · ₹84.74 each · ₹169.48 · unique reach 2,958 (Meta) |
| `e4af72be` MEZZA client report, 3 campaigns, Jul | ready | PDF 405 KB, Excel 37 KB (incl. **Campaigns** sheet) | ₹1,694.91 · CPR "—" (mixed objectives) · "Reach (sum)" · 1 of 10 days missing (Hiring Poster, 1 Jul) |

PDF first pages and the image were checked visually: the branded background renders, labels are honest, and nothing overflows.

**Rows left in production from this run.**
- `9f581ae1`: failed, from before the fix. Its automatic retry job was **cancelled** so no worker picks it up later.
- `42c76853`: partial (Excel only), from before the fix.
- `2e63987d`, `a4bd0e06`, `e4af72be`: ready.

Two older reports for Sea Star (`3b1bb965`, `d436dd11`, made 18:01 IST via the old synchronous path) are marked `ready` but have **no files**. That is the AUD-11 symptom, fixed in the current code.

**Still not verified.**
- The HTTP generate route and in-page progress in a running dev server, which needs free memory.
- Email delivery, which was deliberately never attempted.

**Cleanup (25 Oct, at the user's request).** All seven reports above were deleted with the app's own `deleteReportStorageAndRow`, using the same checks as `DELETE /api/advertising/reports/[id]`: 9f581ae1, 42c76853, 2e63987d, a4bd0e06 and e4af72be from the verification, plus the two empty ones, 3b1bb965 and d436dd11. That removed 7 storage files. A read-only check confirmed 0 rows, 0 analytics rows and 0 files remain, and report history is now empty.


## Completion pass — 26 Oct 2026 (IST)

This section supersedes earlier outstanding-feature notes. These changes are local; the three new migrations below have **not** been applied. The earlier production verification only covers the earlier pipeline, not these new review/delivery tables.

### Implemented

- Persisted preview snapshots, tied to the editor, client, settings hash and 24-hour expiry. Generate uses the exact reviewed snapshot across every export/retry. Read-only previews remain available; saving drafts uses a separate write guard. Changing settings requires another preview. Missing-day/result data or failed sync requires an explicitly incomplete draft, which cannot be emailed or publicly approved.
- Sync-period action and enforced sync-before-report for scheduled/new unsnapshotted jobs, including comparison dates and suppression of unrelated notification jobs. FX/ingest failures cannot be marked as successful sync.
- Review status independent of generation and delivery. Edited summaries produce a new immutable version; the previous version becomes superseded only when its replacement is ready and approved.
- Revocable 1/7/30-day report links: random 256-bit token, only its SHA-256 hash stored, server checks report approval/status/expiry/revocation on every request. Public HTML has an explicit client-field allowlist, escaped text, no internal payload/downloads, no indexing and no caching.
- English/Malayalam preference and factual Malayalam summaries; optional edited summary. PDFs include readable supplementary summary/campaign pages. Image ZIP contains every rendered PDF page. Copy/download and device share-sheet controls remain user initiated.
- Campaign creative comparison uses the existing Meta integration, selected campaign and dates, native currency, objective-specific results, unavailable-media fallback and small-sample warning without winner claims.
- Campaign annotations with chart markers; existing CRM records receive enquiry-quality/status/reason reviews, separately labelled from provider totals. Budget requests retain requester/approver, currency, expiry and decision; approval does not change platform budgets, receipts or allocations.
- Signed Resend event webhook with deduplicated event inbox, out-of-order reconciliation, accepted/delivered/bounced/failed separation. Per-recipient sending claims prevent concurrent duplicate sends; failed recipients can be retried explicitly. Ambiguous external-call outcomes remain held for provider review.
- Separate schedule last-enqueued, last-generated and last-confirmed-delivered timestamps. Scheduled reports await review before email; approval never sends silently.

### Apply before deploying this code

After the three previously applied migrations, apply in order:

1. `20261025210000_report_review_and_sharing.sql`
2. `20261025211000_campaign_review_tools.sql`
3. `20261025212000_report_delivery_events.sql`

The last migration also installs schedule lifecycle tracking. Rollbacks in `supabase/rollbacks/` reverse executable paths in reverse order while deliberately retaining audit/history tables and columns. Roll back application code alongside SQL; disable the provider webhook before rolling back its functions. These are data-preserving operational rollbacks, not schema-reset scripts; re-enabling requires restoring grants/functions, not blindly rerunning CREATE TABLE.

### Verification and live requirements

- Final full suite: **3,018 passed, 3 skipped** (227 passed test files, one skipped). Includes public-route malformed/expired/revoked/superseded access denial and escaped/no-store responses, plus webhook signature rejection/event handling.
- Final TypeScript check passed. ESLint passed with 0 errors / 2,127 warnings, within the existing 2,128 budget. The final repeated whole-repository lint stalled without output and was stopped; focused lint of the final added/changed files passed with no findings. Employee-name privacy gate passed.
- Malayalam and four-campaign supplementary pages rendered and visually inspected; characters shaped correctly and content fit. Visual fixture test passed with `REPORT_VISUAL_QA=1`. No client email was sent.
- Production build reached compilation, then failed fetching the existing Inter and Geist Mono fonts from Google Fonts because the network connection was unavailable. No font or global typography change was made to disguise this environmental failure.
- No PostgreSQL CLI, database connection URL or Supabase management credential is available in this session. New SQL functions/triggers still need staging execution and concurrency tests; the existing REST service key cannot execute arbitrary migrations. A final read-only REST probe of all three new tables could not connect, so their live presence could not be independently confirmed.
- Set `RESEND_REPORT_WEBHOOK_SECRET`, register `/api/webhooks/report-email` for email.delivered/email.bounced/email.failed, then verify a permitted test recipient before enabling live email. Signature rejection and event handling are covered by mocked route tests; external delivery is not claimed verified.
- `vercel.json` still declares daily scheduler/worker triggers. A deployed trigger owner/plan supporting the intended local send frequency must be confirmed; interactive generation wakes its own job immediately. Do not claim precise hourly delivery from the daily trigger.
- Google Ads remains explicitly unavailable. Developer-token/account approval, provider completion and a permitted account reconciliation are outstanding; it is not production-ready.
- New UI browser end-to-end verification requires a running authenticated dev environment with the new schema. Prior browser/export evidence above applies only to the earlier implementation. No deployment or live platform spend change was performed.
