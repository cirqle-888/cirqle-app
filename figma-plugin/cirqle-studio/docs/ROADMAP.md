# Roadmap

## Phase 1 (this build) — data pipeline replacement ✅
Connect → load offers → select client/offer/template/page → validate →
build cards → report. Read-only, token-auth, existing templates unchanged.

## Phase 2 — round trip + polish
- **"Mark as designed" write-back**: one POST route setting a
  `designed_at` / status flag on the campaign, so the Requests inbox shows
  design progress without asking the designer. (Small, additive migration.)
- **Per-designer API keys** instead of the shared workspace secret —
  revocable individually, name shows up in change logs.
- **Changed-since-build detection**: the offers route already returns
  `updatedAt`; the plugin can show "offer changed since you built" and offer
  a one-click rebuild.
- **Background removal on placement** (port from the Flyer Kit prototype:
  on-device u2netp, no per-image cost) as an optional toggle.
- **Auto-export** of the built frame to PNG for WhatsApp proofing.

## Phase 3 — deeper automation (within the Figma ceiling)
- **Watch mode**: plugin left open polls for campaign changes and rebuilds
  automatically (prototype exists in Flyer Kit).
- **Multi-template layouts**: hero + standard card assignment by rule
  (e.g. first N products, or badge-driven).
- **Brand/SKU columns** — after the owner decides the schema question
  (link offer rows to the global catalog, and bless product_code or barcode
  as the SKU). The API and plugin already carry the fields as null.

## Phase 4 — explicitly deferred decisions
- **AI generation** (deliberately out of scope per the build instruction).
- **Retiring Google Sheets entirely** — flip clients off the Sheet pipeline
  once Studio has run a few real weeks; both consume the same
  `buildOfferSheetRows` contract so there is no migration, only a habit
  change.
- **Figma Org private-plugin publishing** for one-click team installs.
