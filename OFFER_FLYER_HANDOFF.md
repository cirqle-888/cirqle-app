# Cirqle — Offer Flyer System: Continuation Handoff

> **Purpose:** hand this file to a fresh Claude (different account/session) so it can continue the
> remaining Offer Flyer work with full context. It is self-contained — you should not need the prior
> conversation. Read sections 1–3 before touching code; the actual work is in **section 4**.

---

## 0. STATUS UPDATE — 2026-07-16 (section 4 tasks completed)

All of section 4's remaining tasks are now DONE and verified (tsc clean, `npm run build` green,
278 tests pass, no new ESLint errors). A 6-finding adversarial review was run and all 6 findings fixed.

- **Task 10 (Start from last week)** ✅ — `cloneLastCampaign(token)` in `actions.ts` returns the most
  recent finalised/archived campaign's products (price blanked, ids dropped, badges carried). Button
  in the empty state.
- **Task 7 (CSV / missing-images / paste-image)** ✅ — `offerSheetCsv()` in `src/lib/offer-sheet.ts`
  (with formula-injection guard + tests); "Download CSV" button; "Missing images only" view filter
  (drag + sort/shuffle disabled while active so hidden rows can't be scrambled); paste-image from
  clipboard in both list and grid; Drive/Dropbox share-link warning.
- **Task 8b (drag-reorder)** ✅ — @dnd-kit sortable, one `DndContext` per page, `reorderPage()`
  reindexes `display_order`. The `GripVertical` handle is now the real drag handle.
- **Task 9 (dead scaffolding)** ✅ — removed `ai-service.ts`, `AiAssistantPanel.tsx`,
  `CollaborationStatus.tsx`, `useCollaborationContext.tsx`. `ValidationPanel`/`useValidationEngine`
  kept (genuinely used).
- **Editor Google-Sheet sync status (staff)** ✅ — Saving/Syncing/Synced/Sync-failed chip on the
  internal `/dashboard/offer-prepare` entrance (client entrance unchanged). Token-gated
  `getCampaignSyncStatus` + `resyncOfferSheet`. `syncCampaignToSheet` now clears a stale
  `sheet_sync_error` at the start of each attempt (also cleans up the campaign-card display).
- **Offer-Prepare permission** ✅ — new `offer.prepare` permission (`PERMS.OFFER_PREPARE`), migration
  `20260716100000_offer_prepare_permission.sql`, both offer-prepare routes gated via
  `loadCurrentUser` + `hasPermission` (admins bypass). **See section 7 — needs a migration + a grant.**

**Still deferred (need owner buy-in — NOT done):** the Freeze-on-handoff snapshot and the
performance refactor (batch `saveCampaign`, virtualization) in the "Deferred" block of section 4.

### Additional work landed 2026-07-16 (second session — do not redo)

- **Shared-script Google Sheet sync** ✅ — ONE standalone Apps Script now serves all clients.
  `company_settings` keys `offer_sheet_webhook_url` + `offer_sheet_secret`; per-client setup is just
  pasting the client's Sheet link (`clients.offer_sheet_url`). Legacy per-client webhook still wins
  when set. Files: `src/lib/google-sheets/sync.ts` (`extractSheetId`, global resolution, secret in
  payload), `apps/offer-intake/actions.ts` (`getGlobalSheetConfig`/`saveGlobalWebhookUrl`/
  `regenerateSheetSecret`, sheet-link validation), settings UI `GlobalSyncCard`, offer-prepare picker
  readiness. `GOOGLE_SHEETS_SETUP.md` fully rewritten for the one-script model (incl. the SECRET check
  and the "deploying account needs Editor on every client sheet" requirement). **Owner still needs to
  deploy the shared script once and paste client Sheet links.**
- **In-browser background removal** ✅ — "Remove BG" on product images (list menu + expanded section +
  grid overlay). onnxruntime-web (MIT, `onnxruntime-web/wasm` cpu subpath) + u2netp model
  (Apache-2.0) served from `public/models/` (+ `public/models/ort/` wasm; NOTE: default
  `onnxruntime-web` import requests the `.jsep` wasm — keep the `/wasm` subpath import).
  `src/lib/images/remove-background.ts`; token-gated `fetchExternalImage` proxy in intake actions
  (SSRF-guarded) for CORS-less external links; output PNG saved via the normal signed-upload path so
  the catalog mirrors/reuses it. Deliberately NOT @imgly/background-removal (AGPL-3.0).
- **Pending next:** theme-aware reskin of the offer editor (owner approved) — convert hard-coded dark
  classes in `offer-intake-client.tsx` to theme tokens; keep violet accents and white-on-colored-button
  text; status colors need paired `dark:` variants; use `logoDarkUrl`.

---

## 1. Project essentials

- **App:** Cirqle — a Business Operating System. Repo root: `/Volumes/FQLab/Projects/cirqle-app` (adjust to wherever it's checked out).
- **Stack:** Next.js 16 (App Router), Supabase (Postgres + Storage), TypeScript, Capacitor, Tailwind. AI parsing via **Groq** (`qwen/qwen3-32b`).
- **⚠️ Read this first — non-standard Next.js:** the repo's `AGENTS.md` says *"This is NOT the Next.js you know. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code."* APIs/conventions may differ from training data. Honor it.
- **Verification commands** (run after every change; all must stay green):
  ```bash
  npx tsc --noEmit -p .          # must exit 0
  npx eslint "src/**/*.{ts,tsx}" # pre-existing no-explicit-any errors exist; add NO new ones
  npm run build                  # must exit 0
  ```
  The repo already has ~150 pre-existing `no-explicit-any` lint errors; the build does **not** fail on them. Don't try to fix them all — just don't add new lint errors, and keep tsc + build green.

---

## 2. Guardrails — do NOT violate these

These are hard product/architecture constraints from the owner. Breaking them is worse than doing nothing.

1. **Figma is the only design environment.** Cirqle prepares *structured, designer-ready data* and stops. **Never** build: PDF generation, image generation, a Canva-like editor, an internal flyer builder, a visual template engine, or image export. The Google Sheet → Figma Google-Sheets-plugin pipeline is the delivery path and must remain.
2. **Do NOT change the Google Sheet output columns.** The contract lives in `src/lib/offer-sheet.ts` as `OFFER_SHEET_HEADERS`. Columns, order, and names must not change — Figma bindings depend on them. Adding internal features (snapshots, etc.) must not add sheet columns. **Update 2026-07-16 (owner instruction):** the contract is now **15 columns** — `Price 1` and `Price 2` were APPENDED after the original 13 (split price: ₹20.99 → "20" / "99"; whole rupees leave Price 2 empty) so the paisa can be a separate smaller Figma text layer. The original 13 keep their exact order/names; any future change must likewise only append.
3. **Employee-name privacy rule (enforced by ESLint — you WILL trip it):** employee real names must never render unless "privacy is unlocked"; show the CQID (e.g. `CQID001`) by default. Never write `{emp.name}` / `employee.name` / `assignee.name` / `me.name` etc. in JSX or template literals. Use `dn(emp)` from `src/contexts/privacy-context.tsx` or `<EmployeeName emp={emp} />` from `src/components/ui/employee-name.tsx`. A `no-restricted-syntax` rule in `eslint.config.mjs` fails the build on violations. (Clients/products are NOT employees — their names are fine.) The Offer Flyer subsystem has no employee names, so this rarely bites here, but keep it in mind.
4. **Keep batches small and verified.** Prefer several focused, individually-verified changes over one giant diff.

---

## 3. What's already done (do not redo)

Three workstreams are uncommitted in the working tree. The first two are **complete and verified**; the third is **in progress** and is your job.

**A. Employee-name privacy (COMPLETE, verified).** `dn()`/`<EmployeeName>` render path, hardened `EmployeeAvatar` (masks initials/alt when locked), server-side notification/log leaks fixed to CQID, and the `no-restricted-syntax` ESLint guard. Exempt files: `privacy-context.tsx`, `lib/utils/employee-display.ts`, `components/ui/employee-name.tsx`, `src/lib/payslip/**`. Don't undo this.

**B. Pricing-matrix extraction (COMPLETE, verified).** Moved Clients + Pricing Matrix out of Settings into a standalone full-canvas page at `src/app/(dashboard)/dashboard/pricing-matrix/`, added to sidebar nav (`src/lib/nav-sections.ts`). Not part of Offer Flyer.

**C. Offer Flyer improvements (IN PROGRESS — your work).** Done so far:
- **cancelCampaign status bug** — `cancelCampaign` in `src/app/intake/offer/[token]/actions.ts` writes `status:'cancelled'` which violated the DB CHECK (`active|finalised|archived`). Fixed via **new migration** `supabase/migrations/20260716090000_offer_campaign_cancelled_status.sql` (adds `cancelled`). **The human must apply this migration to Supabase.**
- **Keyboard shortcuts wired** — `useKeyboardShortcuts` in `offer-intake-client.tsx` was called with `{}` (dead). Now wired: ⌘A select-all, ⌘⇧A clear, Del delete-selected, ⌘D duplicate, ⌘⇧P/W/B/M bulk price/weight/badge/move-page, ⌘⇧I AI capture, ⌘S save.
- **Real bulk operations** — the selection toolbar in `offer-intake-client.tsx` went from *weight + delete* to **Price / Weight / Badge / Move-page / Duplicate / Copy / Delete** (helper fns `bulkSetPrice`, `bulkSetWeight`, `bulkSetBadge`, `bulkMoveToPage`, `duplicateSelected`, `deleteSelected`, `copySelected`).
- **Copy Selected** — copy logic refactored into `copyProductsAsTable(list, label)`; `copyOfferTable` and `copySelected` both call it.
- **"Changed since last sync" flag** — `src/components/campaigns/campaign-card.tsx` now shows a *"Sheet out of date"* header chip + amber sync-row line when `updated_at > sheet_last_synced_at` (var `staleSinceSync`). This is the stale-artwork safety signal.

---

## 4. REMAINING TASKS (your work, priority order)

> Line numbers below may have drifted — navigate by **function/symbol name**, not line number.
> The main editor file is large (~1,900 lines): `src/app/intake/offer/[token]/offer-intake-client.tsx`.

### Task 10 — "Start from last week" clone + auto-carry badges  ⭐ HIGHEST DAILY VALUE
**Why:** coordinators re-enter mostly the same products every week. This collapses a 100-product campaign into "edit ~15 prices."

**Part A — Clone previous campaign:**
- Add a server action (in `src/app/intake/offer/[token]/actions.ts`) e.g. `cloneLastCampaign(token)` that: resolves the client via `resolveOfferToken`, finds that client's most recent non-active campaign's products, and returns them as `ProductInput[]` (keep name/weight/image_url/offer_type/mrp/badges/page/display_order; **blank the `price`** so the coordinator sets fresh prices; drop `id` so they insert as new rows).
- In `offer-intake-client.tsx`, add a **"Start from last week"** button (visible when `products.length === 0`, near the AI Capture button) that calls it and loads the rows into `products` state (mirror how `confirmBulkPaste` builds `LocalProduct` rows with fresh `_key`s).
- Edge cases: no previous campaign → button hidden or shows a toast. Don't clone the campaign header/dates (those are new each week) — only products.

**Part B — Carry badges via catalog:**
- Today `client_product_catalog` stores name/weight/image but **not badges**, so badges are re-picked weekly. Two options — pick the simpler that fits:
  1. (Preferred, no schema change) Since clone (Part A) already carries badges from the previous *campaign's* products, Part A largely solves the "reuse badges" need without touching the catalog. Verify clone carries `offer_products` badges (join `offer_product_badges`).
  2. (If you want catalog-level reuse) add a `badges jsonb` (or similar) to `client_product_catalog` via migration and populate it in the catalog-mirror path inside `saveCampaign` (`actions.ts`), then apply on catalog pick in `addFromCatalog`. Heavier; only if Part A isn't enough.
- **Recommendation:** do Part A (clone) first — it delivers the badge-reuse benefit. Only add the schema change if the owner specifically wants badges reused via the *catalog picker* path too.

### Task 7 — CSV download + "missing images only" filter + paste-image
- **CSV download:** `src/lib/offer-sheet.ts` already has `offerSheetTsv(rows, includeHeaders)`. Add a sibling `offerSheetCsv(rows, includeHeaders)` (comma-joined, quote cells containing `, " \n`, escape `"`→`""`). In `offer-intake-client.tsx` add a "Download CSV" action next to "Copy table" that builds a Blob and triggers a download (`a[download]`). Do **not** change the sheet columns — CSV uses the same `buildOfferSheetRows`.
- **"Missing images only" filter:** add a toggle in the products toolbar that filters the rendered list to products where `!image_url`. The #1 flagged bottleneck is "offers waiting for images," so a one-pass gap view is high value. Keep it a view filter over the existing `products` state (don't mutate order).
- **Paste-image-from-clipboard:** in the product image menu (in `ProductRow`/`ProductGridCard`), support pasting an image from the clipboard (a screenshot) → upload via the existing `handleUploadImage` path (`getImageUploadUrl` signed PUT to the `product-images` bucket). Also accept a direct image URL paste (already supported via `isPublicImageUrl`) — optionally warn if the URL is a Google Drive/Dropbox *share* link (not hotlinkable → breaks in Figma).

### Task 8b — Real drag-reorder within a page
- Today a `GripVertical` handle is rendered in `ProductRow` but **no drag is wired** (decorative). Products' flyer order is `display_order`; currently only price-sort/shuffle buttons (`sortPageProducts`) change it.
- Implement drag-and-drop reorder **within a single page** (don't cross pages via drag — that's what "Move page" bulk op is for). Check `package.json` for an installed DnD lib (`@dnd-kit/*` preferred) before hand-rolling pointer handlers. On drop, reindex `display_order` for that page (mirror the `.map((p,i) => ({...p, display_order:i}))` pattern used in `sortPageProducts`/`removeProduct`).
- If no DnD lib is installed and adding one is undesirable, a lighter acceptable fallback is per-row up/down buttons — but confirm with the owner; drag is the requested UX.

### Task 9 — Remove dead scaffolding
Verify each is truly unused (grep imports) before deleting:
- `src/app/intake/offer/[token]/components/ai-service.ts` — a **stub** heuristic "AI" (fake 800ms delay, comment "FUTURE: connect real AI"). The real parser is `src/lib/ai/offer-capture.ts`. Remove the stub and its consumer `AiAssistantPanel.tsx` if the panel is not load-bearing.
- `components/ValidationPanel.tsx`, `useValidationEngine.ts`, `useCollaborationContext.tsx`, `CollaborationStatus.tsx` — audit whether these are actually wired into the live flow. `useValidationEngine(products)` **is** called in `offer-intake-client.tsx` (var `validation`) — check whether `validation` is actually rendered/used; if it's dead, remove it. Only delete what's genuinely unused.
- The `GripVertical` handle: if you do Task 8b, wire it; if not, remove it (a control that looks draggable but isn't erodes trust).

### Deferred (larger — confirm scope with owner before starting)
- **Freeze-on-handoff snapshot (Critical, data integrity).** Introduce a live/editable vs handed-off state: "Hand off to design" writes an immutable snapshot of the rows; that snapshot is what syncs to the sheet and what the designer pulls. After handoff, live edits mark "changed since handoff" (the `staleSinceSync` flag already models the sync version of this) instead of silently auto-overwriting the sheet. Gives rollback + diff-before-resync. **Must NOT add sheet columns** — the snapshot is internal (a table or a jsonb column on `offer_campaigns`). This is the highest-value architectural item but needs a small data-model design; get owner buy-in on the UX first.
- **Performance for 100–200 product campaigns.** (a) `saveCampaign` in `actions.ts` does per-product sequential awaits (diff + upsert + catalog mirror + badge replace) — batch it. (b) The editor renders all products via nested `.map()` with controlled inputs and no virtualization — add virtualization (or an editable grid) for large campaigns. Both are real but larger refactors.

---

## 5. Offer subsystem file map (navigation)

| Concern | File(s) |
|---|---|
| **Main editor UI** (both entrances share it) | `src/app/intake/offer/[token]/offer-intake-client.tsx` (~1,900 lines) |
| **Server actions** (save, parse, image upload, cancel) | `src/app/intake/offer/[token]/actions.ts` |
| **Public tokenized page** | `src/app/intake/offer/[token]/page.tsx` |
| **Editor add-on components** (some are dead scaffolding — see Task 9) | `src/app/intake/offer/[token]/components/` |
| **Internal (staff) entrance** — same editor, reached by client not token | `src/app/(dashboard)/dashboard/offer-prepare/` |
| **Team review card** (change-log, sync status, finalise/archive) | `src/components/campaigns/campaign-card.tsx` (rendered inside the **Requests inbox**, `src/app/(dashboard)/dashboard/requests/page.tsx`) |
| **Campaign lifecycle actions** (resync, finalise, archive, ack logs) | `src/app/(dashboard)/dashboard/campaigns/actions.ts` |
| **Sheet column contract + TSV** (⚠️ frozen columns) | `src/lib/offer-sheet.ts` (+ test `src/lib/offer-sheet.test.ts`) |
| **Google Sheet sync** (per-client Apps Script webhook; full clear+rewrite) | `src/lib/google-sheets/sync.ts` |
| **AI parser** (real; Groq) | `src/lib/ai/offer-capture.ts`, `src/lib/ai/groq.ts` |
| **Catalog** (client + global product reuse, image history) | `src/app/(dashboard)/dashboard/catalog/`, tables below |
| **Settings** (webhook URL, intake token, sheet URL) | `src/app/(dashboard)/dashboard/apps/offer-intake/` |

---

## 6. Data model reference

**`offer_campaigns`**: `id, client_id, offer_token, title, date_type('single'|'range'), offer_date, offer_date_from, offer_date_to, status('active'|'finalised'|'archived'|'cancelled' — 'cancelled' added by the new migration), sheet_last_synced_at, sheet_sync_error, created_at, updated_at`.

**`offer_products`**: `id, campaign_id, catalog_id, name(NOT NULL), weight, image_url, offer_type('price'|'percent'|'bogo'|'other'), price, mrp, offer_text, page(int default 1), display_order(int), created_at, updated_at`. (Legacy single `badge_id` column exists but is unused — badges now live in the join table.)

**`offer_product_badges`** (multi-badge join): `id, product_id, badge_id(nullable), custom_label, color(default amber), display_order`. CHECK: at least one of badge_id/custom_label.

**`offer_badges`** (predefined, managed in Settings): `id, label, color, display_order, is_active`.

**`client_product_catalog`** (per-client reuse): `id, client_id, name, weight, image_url, category, is_active` — **no badges column today** (relevant to Task 10B).

**`offer_change_logs`** (auto field-level diff on save): `campaign_id, log_type, product_id, product_name, field, old_value, new_value, note, acknowledged, acknowledged_by, acknowledged_at`.

**Global catalog:** `product_catalog` + `product_catalog_images` (image history, `is_primary`) + `client_product_assignments`, mirrored on every save via `mirrorProductToGlobalCatalog` in `actions.ts`.

**Sheet output (15 columns, `OFFER_SHEET_HEADERS`):** Page Number, Display Order, Product, Weight, Offer Type, Offer Price, MRP, Offer Text, Badges, Image URL, Offer Title, Offer Date, Client, Price 1, Price 2. (Price 1/Price 2 = split price for the two-layer design, appended 2026-07-16 per owner; ₹20.99 → "20"/"99", whole rupees → Price 2 empty.)

**AI parser extracts:** name (incl. pack size), weight, price, mrp, badge. It does **not** extract brand/quantity/unit/offer_type/category, and is **text-only** (no OCR/PDF/Excel/image parsing).

---

## 7. Action items for the human (not code — tell the owner)

0. **Apply THREE migrations to Supabase** (in order):
   - `supabase/migrations/20260716090000_offer_campaign_cancelled_status.sql` (the cancel fix).
   - `supabase/migrations/20260716100000_offer_prepare_permission.sql` (seeds the `offer.prepare`
     permission). **After applying it, in Settings → Access & Roles grant `offer.prepare` to every
     NON-admin designation that prepares offer flyers** — otherwise those employees lose access to
     `/dashboard/offer-prepare` (admins are unaffected; they bypass the catalog).
   - `supabase/migrations/20260716110000_offer_campaign_lifecycle.sql` (adds `completed_at` /
     `archived_at`; additive, backfills finalised/archived rows). Needed by the weekly-offer
     workflow and the auto-archive job.

0a. **Dedicated offer-flyer designers (NEW).** "Prepare Offer" now appears in the sidebar Work
   section for anyone holding `offer.prepare` (admins always). For a *dedicated* flyer designer,
   create a designation granting **only `offer.prepare`** (no `requests.view`): their AI Capture
   then runs in **offer mode** — every paste parses directly as an Offer with no
   "Choose a destination" step, and "Open in Offer" lands in Prepare Offer.

0a-2. **Table (spreadsheet) view (NEW).** The offer editor has a third view mode — List / Grid /
   **Table** — on both entrances (public client + staff). The table is one flat editable grid whose
   columns mirror the designer sheet (Page, #, Product, Weight, Type, Price, MRP, Offer text,
   Badges, Image): cell-by-cell inline editing, Enter jumps to the same column on the next row
   (adding a row at the bottom), badges typed as comma-separated labels (predefined matched by
   label, else custom), image upload per row, row checkboxes reuse the bulk-ops toolbar.
   Component: `ProductTableView` in `offer-intake-client.tsx`. Verified live in the browser.

0a-3. **Name-casing bulk tools (NEW).** The selection toolbar has an AA / Aa / Aa Bc group that
   re-cases the selected product names: UPPERCASE, First-letter capital, and professional Title
   Case (connector words like of/with/per and unit tokens like 500gm/1kg stay lowercase).
   Helper: `src/lib/format-product-name.ts` (+ tests). Works in list, grid, and table views via
   Select All / row checkboxes. Also fixed the pre-existing ValidationPanel rules-of-hooks bug
   (useMemo now runs before the zero-issues early return).

0b. **Weekly-offer workflow (NEW — fixes the "old + new offer list merged" bug).** Opening a client
   in *Prepare Offer* that already has an active offer now shows a modal **before loading products**:
   *Start New Weekly Offer* (empty, previous auto-finalised on save) / *Continue Current Offer* /
   *Start From Last Week* (clone products, prices cleared) / *Cancel*. AI Capture no longer silently
   appends — a whole-list capture into a non-empty offer asks Replace vs Add. `saveCampaign` enforces
   **one active campaign per client** (creating a new offer finalises the previous). An **auto-archive
   cron** (`/api/cron/archive-offers`, registered in `vercel.json`, daily 02:00) archives finalised
   offers older than the retention window. Retention is configurable via the `company_settings` key
   **`offer_archive_retention_days`** (default 90; `never`/`0` disables). *Deferred (tell me if wanted):*
   a Settings **UI dropdown** for retention and a dedicated **Offer History page** — finalised offers
   already stay visible in the Requests inbox, so no history is lost, and nothing is ever auto-deleted.
1. **Apply the migration** `supabase/migrations/20260716090000_offer_campaign_cancelled_status.sql` to Supabase (the cancel fix needs it).
2. **Webhook security (Critical).** The per-client Google Apps Script endpoint is deployed "Anyone" access with **no shared secret** on the POST (`src/lib/google-sheets/sync.ts` + `GOOGLE_SHEETS_SETUP.md`). Anyone who learns a client's `offer_sheet_webhook_url` can overwrite their sheet. Fix requires editing the **Apps Script** (add a secret-header check) *and* the app send-side. This is a human+code task — flag it; don't silently skip.
3. **Deploy:** the working tree has multiple uncommitted workstreams (privacy, pricing-matrix, offer-flyer). Confirm with the owner what gets committed/deployed together, and how this project deploys (git remote `main` on branch `main`; check for Vercel/CI). Deploying is outward-facing — confirm before pushing.

---

## 8. Definition of done (per task)

- `npx tsc --noEmit -p .` exits 0.
- `npm run build` exits 0.
- No **new** ESLint errors (`npx eslint` — ignore the pre-existing `no-explicit-any` noise).
- No new Google Sheet columns; the 13-column contract unchanged.
- Employee-name privacy rule not tripped.
- Where observable, verify behavior in the running app (the repo has a browser-preview workflow; `npm run dev` on port 3000).
