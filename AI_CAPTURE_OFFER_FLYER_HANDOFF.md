# Cirqle — AI Capture & Offer Flyer Handoff

This document provides the product context and implementation state for continuing work in another GPT account.

## Product goal

Cirqle is a Next.js 16 / Supabase business operating system for a creative agency.

The user's main recurring work is **Offer Flyer** work. The intended production pipeline is:

```text
WhatsApp / email / plain-text offer list
  → Cirqle AI Capture
  → Offer product review
  → Google Sheet
  → Figma Google Sheets plugin
  → Flyer design in Figma
```

**Do not build a flyer canvas, PDF exporter, or image generator in Cirqle.** Figma is the design surface. Cirqle should make collecting, reviewing, structuring, and exporting flyer data fast and reliable.

## Core product decisions

### 1. AI Capture is the single front door

The feature previously called **Quick Capture** should be called **AI Capture**.

It handles all incoming content, not just flyers:

- general design requests
- Offer Flyer product lists
- advertising requests
- internal tasks
- quotations
- invoices / payment-related text
- new client contacts

The flow must always be:

```text
Paste message → AI classifies and detects client → user reviews → user confirms
```

AI must never create records without human confirmation.

### 2. Offer Flyer has a focused AI Capture mode

On an existing offer page, the client and target flyer page are already known. Therefore, do **not** run broad classification again. Use the offer-product parser directly:

```text
AI Capture to Page 2
  → paste WhatsApp offer list
  → parse product / price / MRP / badge
  → review rows
  → add to Page 2
  → sync Google Sheet
```

### 3. Google Sheets is the data contract for Figma

The sheet columns and their order must remain stable, so Figma components can bind once and refresh for every offer.

The stable headers are:

| Page Number | Display Order | Product | Weight | Offer Type | Offer Price | MRP | Offer Text | Badges | Image URL | Offer Title | Offer Date | Client |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

The Offer page should also support **Copy table** and **Copy Page table**. It must copy tab-separated rows with these exact headers, so users can paste directly into Google Sheets or Excel when webhook sync is unavailable.

### 4. Product images can use public URLs

For every product, users need three image choices:

- upload a new image
- choose a past catalog image
- paste a public image URL

The public URL must be a direct, publicly accessible `http` or `https` image URL. It is sent unchanged to Google Sheets and used by the Figma plugin.

## Existing architecture

### Universal AI Capture

- UI route: `src/app/(dashboard)/dashboard/capture/`
- Engine: `src/lib/capture/engine.ts`
- Classifier: `src/lib/capture/classify.ts`
- Module adapter registry: `src/lib/capture/router.ts`
- Offer adapter: `src/lib/capture/adapters/offer.ts`

The engine already classifies `request`, `offer`, `advertising`, `task`, `quotation`, `invoice`, and `client` content. It detects the client once and sends the user to a review/confirmation step.

The offer adapter uses the specialized offer parser and hands parsed products to the internal Offer Prepare page through `sessionStorage` key `cirqle:capture:draft`.

### Offer Flyer workflow

- Public client page: `src/app/intake/offer/[token]/`
- Staff picker: `src/app/(dashboard)/dashboard/offer-prepare/`
- Shared offer editor: `src/app/intake/offer/[token]/offer-intake-client.tsx`
- Google Sheets sync: `src/lib/google-sheets/sync.ts`
- Apps Script setup: `GOOGLE_SHEETS_SETUP.md`
- Product catalog: `src/app/(dashboard)/dashboard/catalog/`

The public and internal staff routes deliberately render the same Offer editor. The public route is token gated; staff select a client first.

## Work already implemented in this working tree

These changes are uncommitted as of 2026-07-16.

### AI Capture entry points

- Renamed visible Quick Capture UI/metadata to **AI Capture**.
- Added a global **AI Capture** button in the dashboard header.
  - It attempts to read clipboard text when browser permissions allow.
  - It still opens the universal manual paste field if clipboard access is denied.
- Added **AI Capture** to the Work navigation section.

### Offer page improvements

- Fixed the per-page AI Capture target bug: choosing AI Capture on Page N now keeps Page N selected instead of resetting to the newest page.
- Renamed offer bulk-paste UI to context-specific **AI Capture to Page N**.
- Added **Copy table** for the whole offer and **Copy table** for each page.
- Added a robust clipboard fallback for browsers that do not expose `navigator.clipboard`.
- Added a public image URL entry option in both list and grid product editors.
- Public-link UI warns users when the URL is not a public `http(s)` URL.

### Stable Figma/Sheets output

- Added `src/lib/offer-sheet.ts`.
- Both the Google Sheet webhook sync and UI clipboard copy now use the same helper.
- Added `src/lib/offer-sheet.test.ts` for header, ordering, and TSV escaping.
- Updated `GOOGLE_SHEETS_SETUP.md` with the new stable Figma data contract.

### Offer correctness/security fixes

- Fixed header change logging: old campaign header values are now loaded **before** update, so title/date changes are logged correctly.
- Secured offer cancellation: `cancelCampaign` now resolves the current public token and checks that the campaign belongs to that token's client and is active before it can be cancelled.

## Validation completed

```text
npm test      # 33 files passed, 275 tests passed
npm run lint  # passed
git diff --check  # passed
```

`npx tsc --noEmit` is currently blocked by five pre-existing errors in `src/app/(dashboard)/dashboard/requests/requests-client.tsx`. They concern a nullable `cqid` passed to the `dn(...)` display helper and are unrelated to this Offer/AI Capture work.

## Important UX principles for future work

1. Keep the main flow fast: client → paste → review → sync should take only a few minutes.
2. Use progressive disclosure. Product name, price, photo, and page are the common fields; badges, MRP, special offer wording, and history are secondary details.
3. Do not duplicate AI engines. Global AI Capture classifies content; Offer page AI Capture has a known destination and should parse offer products directly.
4. Preserve one Google Sheets schema. Do not casually rename/reorder columns, because that breaks Figma bindings.
5. Manual table copy is a first-class fallback, not a hidden technical feature.
6. Keep Figma-specific design work outside Cirqle.

## Suggested next improvements

### Highest priority

> **Status 2026-07-16:** items 2 and 3 are DONE (see `OFFER_FLYER_HANDOFF.md` §0). Item 1 (Offer
> Designer queue) is NOT done — it's a net-new internal view; the existing Requests-inbox
> `CampaignCard` already surfaces "Sheet out of date" and sync-failure state, so confirm the desired
> UX with the owner before building a separate queue.

1. Add an Offer Designer queue with: `New offer`, `Changed since design`, and `Sheet sync failed`. *(not done — confirm scope)*
2. ~~Add a visible Google Sheet sync result in the Offer editor: `Saved`, `Syncing`, `Synced`, or `Sync failed`.~~ ✅ **Done** (staff entrance; token-gated status poll + retry).
3. ~~Add an explicit offer-specific permission for the internal Offer Prepare route.~~ ✅ **Done** (`offer.prepare` perm + migration; **owner must apply the migration and grant the perm** — see `OFFER_FLYER_HANDOFF.md` §7).

### Later

1. Make the campaign save operation atomic through a Supabase database RPC/transaction; it currently writes campaign, products, badges, catalog links, and change logs through multiple calls.
2. Add stronger public-link validation/preview (including a clear “image can be loaded” status).
3. Add source provenance for photos: `uploaded`, `catalog`, or `public_link`.
4. Improve product matching with normalized name, brand, and barcode to avoid catalog duplicates.

## Repository instructions

- Read `AGENTS.md` before writing Next.js code. This project uses a newer Next.js version with breaking changes.
- Do not overwrite unrelated uncommitted work.
- Use `apply_patch` for file edits.
- The repository has other existing uncommitted changes, including a Pricing Matrix extraction and employee-display privacy changes. Keep this work isolated from those files unless the user explicitly asks otherwise.
