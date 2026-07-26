# Known limitations

Documented honestly: where a limit comes from the Figma Plugin API, a provider
quota, or the Cirqle schema, it is stated here rather than worked around in a
way that would change the product architecture.

## Figma platform limits (cannot be engineered away)

1. **No headless operation.** A plugin runs only while Figma is open with the
   file loaded. A human must click Build. Anything more automatic would mean
   rendering flyers outside Figma, which the product guardrail ("Figma is the
   only design environment") forbids.
2. **No true login flow.** Plugin iframes can't complete a cookie/session
   login, so auth is a bearer token (the workspace's existing shared secret).
   Phase 2 upgrades this to per-designer keys without changing the shape.
3. **Fonts must be installed.** Figma blocks text edits in fonts the machine
   lacks. The plugin names the font in the error and continues with other cards.
4. **CORS + middleware.** The plugin iframe has a `null` origin, so the API
   sends `Access-Control-Allow-Origin: *` (the bearer token is the real gate).
   `/api/figma/*` is also exempted from the session middleware in
   `src/lib/supabase/middleware.ts` — without it, cookieless preflights get
   307-redirected to `/login` and browsers reject redirected preflights
   outright. Same bug class the codebase already fixed for `/api/cron/`.
5. **Variants are respected, not managed.** Cards are instances when the
   template is a component, copies when it's a frame. Automatic variant
   selection by offer type is Phase 3.

## Provider limits

6. **Groq free-tier rate limit (12k tokens/minute).** Sections are parsed
   **sequentially** for this reason — parallel calls reliably 429'd the middle
   section of a three-section paste. A very large multi-day message can still
   hit the ceiling; the affected section reports "AI rate limit hit — wait
   ~30s and press Parse again" and the others still return. Splitting by day
   (which the multi-day guard already encourages) avoids it, as does the Groq
   Dev tier.
7. **Paste caps.** 20,000 characters and 12 sections per parse; 300 products
   per save. All three refuse with an explanation rather than truncating.

## Cirqle schema limits (returned as null, not faked)

8. **`brand`** exists only on the global catalog (`product_catalog.brand`);
   `offer_products` references the per-client catalog, which has no brand
   column. Returned as `null`. Wiring it means linking offer rows to the global
   catalog — an owner decision, not a plugin workaround.
9. **`sku`** exists nowhere. Nearest candidates are
   `product_catalog.product_code` (PRD-XXXXXXXX) and `barcode`. Returned as
   `null` until the owner blesses one as the SKU.
10. **`category`** IS returned, via `offer_products.catalog_id →
    client_product_catalog.category`, but is null for products typed free-form
    without a catalog link.

## Behaviour worth knowing (deliberate, not defects)

11. **One active offer per client.** Saving a two-day paste is blocked with an
    explanation rather than silently merging 60 products into one flyer.
12. **Read-mostly.** The only write is `POST /api/figma/campaign`, which
    delegates entirely to the existing `saveCampaign` server action. No
    "mark as designed" status flows back yet (Phase 2).
13. **Workspace-wide token.** Revoking one designer means rotating for
    everyone — the same blast radius the Sheets sync already has.
14. **Extra selected cards are never blanked** in Fill-selected mode. A stale
    card is recoverable; wiped design work is not.
15. **Title Case leaves digit-leading tokens lowercase** — `4PEC` → `4pec`.
    Inherited verbatim from `format-product-name.ts` so Figma and Cirqle agree;
    change it there if it should differ, and the plugin must be updated to match.
16. **The Sheets pipeline is untouched.** Both consume the same
    `buildOfferSheetRows` contract, so they can run in parallel indefinitely;
    retire the Sheet route by simply not using it.
