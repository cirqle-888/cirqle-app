# Roadmap

## Phase 1 — data pipeline replacement ✅ shipped

Connect → load offers → select client/offer/template/page → validate → build
cards → report. Read-only, token-auth, existing templates unchanged.

## Phase 1.5 — WhatsApp capture ✅ shipped (unplanned, pulled forward)

Added after seeing how clients actually send lists:

- **Section-aware parser** (`src/lib/ai/offer-sections.ts`, 11 tests) — sticky
  `Sunday 100gm` headers, mid-message pack changes, day grouping,
  `Sunday 3 page` hints. Deterministic; the AI only does name/price extraction.
- **`POST /api/figma/parse`** — reuses the existing Groq engine, one call per
  section, sequential to respect the free-tier rate limit.
- **`POST /api/figma/campaign`** — delegates to the existing `saveCampaign`
  server action, so change logs / catalog mirroring / sheet sync all still fire.
- **Paste tab with spreadsheet table** — split-to-columns, column-role
  dropdowns, casing tools (byte-identical to `format-product-name.ts`),
  weight→name, price normalisation, live P1·P2 preview.
- **Fill selected cards** — Google-Sheets-Sync behaviour for cards already
  laid out, matched in reading order.

## Phase 2 — round trip + polish

1. **Per-designer API keys (M).** `figma_api_keys(id, employee_id, key_hash,
   label, created_at, revoked_at)`; SHA-256 hashed, shown once, revocable
   individually. Routes accept a personal key first, falling back to the
   workspace secret during migration. Unlocks attribution in change logs.
2. **Mark as Designed (S–M).** `POST /api/figma/campaign/:id/designed` setting
   `designed_at` + `designed_by`; button after a successful build; state shown
   on the campaign card. Best after #1 for real attribution.
3. **Offer-changed detection (S).** `/offers` already returns `updatedAt` —
   store it at load, compare on Refresh, show a "changed since you built" chip
   with one-click reload. No server work.
4. **Background removal, on-device (M).** Port the proven u2netp /
   onnxruntime-web pipeline from Flyer Kit v2 as a build-time toggle. No
   per-image cost. File-picker model load works day one; `cors-patch.md`
   enables zero-touch loading.
5. **Auto-export PNG (S).** Port `exportBuiltFrame()` from Flyer Kit v2 (2×
   PNG of the built frame). Later: POST to Cirqle for WhatsApp proofing.
6. **Watch mode (M).** Poll `/offers` every 60s, rebuild the armed campaign
   when `updatedAt` changes, chain #4/#5. Ceiling stays "Figma open with the
   plugin running".
7. **Private organization plugin (S, non-code).** Publish to the Figma org for
   one-click installs and central updates. Requires a Figma Org plan; freeze
   the plugin id first.
8. **Retire Google Sheets (S, procedural).** After 2–3 clean weekly cycles:
   switch designers to the plugin per client, stop linking new sheets,
   deprecate the shared script in `GOOGLE_SHEETS_SETUP.md`, keep the webhook
   dormant a month, then remove per-client links. Parity holds throughout —
   both pipelines read `buildOfferSheetRows`.

**Suggested order:** 3 → 5 → 1 → 2 → 4 → 6 → 7 → 8 (quick wins first, write
path after auth). The stated priority order also works; nothing blocks
anything above it except #2's attribution, which degrades gracefully.

## Phase 3 — deeper automation (within the Figma ceiling)

- **Multi-template layouts** — hero + standard card assignment by rule
  (first N products, or badge-driven).
- **Variant selection by offer type** — a `bogo` product picks the BOGO variant
  automatically; nested component swaps.
- **Brand / SKU columns** — after the schema question is settled (link offer
  rows to the global catalog; bless `product_code` or `barcode` as the SKU).
  API and plugin already carry the fields as null.
- **Client lite listing** — `?mode=lite` on the existing tokenized intake link:
  a minimal add-product surface for clients, same backend, one new render path.
  (Discussed and deferred in favour of the WhatsApp pipeline.)

## Explicitly out of scope

- **AI image generation** — deliberately excluded.
- **Rendering flyers outside Figma** — violates the product guardrail.
