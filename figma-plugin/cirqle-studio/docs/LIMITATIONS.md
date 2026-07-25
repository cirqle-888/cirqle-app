# Known limitations

Documented honestly, per the build instruction: where a limit comes from the
Figma Plugin API or the Cirqle schema, it is stated here rather than worked
around in ways that would change the product architecture.

## Figma platform limits (cannot be engineered away)

1. **No headless operation.** A Figma plugin runs only while Figma is open
   with the file loaded and the plugin running. A human must click Build
   Flyer. Anything more automatic than that would require rendering flyers
   outside Figma, which the product guardrail ("Figma is the only design
   environment") forbids.
2. **No true login flow.** Figma plugin iframes can't complete a normal
   cookie/session login against the app, so "Login to Cirqle" is implemented
   as a bearer token (the workspace's existing shared secret). Phase 2 can
   upgrade this to per-designer API keys without changing the plugin shape.
3. **Fonts must be installed.** Figma blocks text edits in fonts the machine
   doesn't have. The plugin reports the font name in the error and continues
   with the other cards.
4. **CORS.** The plugin iframe has a `null` origin. The API routes therefore
   send `Access-Control-Allow-Origin: *` — safe because the bearer token is
   the real gate. Product-image hosts must also allow anonymous GETs (Supabase
   public storage does).
5. **Variants/auto-layout are respected but not managed.** Cards are placed on
   a plain grid inside one new frame. If the template is a component, cards
   are instances (design edits to the master propagate); if it's a frame,
   cards are copies.

## Cirqle schema limits (returned as null, not faked)

6. **`brand`** exists only on the GLOBAL catalog (`product_catalog.brand`);
   `offer_products` references the per-client catalog, which has no brand
   column. The API returns `brand: null`. Wiring it properly means linking
   offer rows to the global catalog — a schema decision for the owner, not a
   plugin workaround.
7. **`sku`** exists nowhere in the schema. Nearest candidates are
   `product_catalog.product_code` (PRD-XXXXXXXX) and `barcode`. Returned as
   `sku: null` until the owner decides which of those (if either) *is* the SKU.
8. **`category`** IS returned — via `offer_products.catalog_id →
   client_product_catalog.category` — but is null for products typed free-form
   into an offer without a catalog link.

## Scope limits (deliberate, Phase 1)

9. **Token auth is workspace-wide**, not per-designer; revoking one person
   means rotating the shared secret (same blast radius the Sheets sync already
   has).
10. **Read-only.** The plugin never writes to Cirqle — no "mark as designed"
    status flowing back yet (see ROADMAP).
11. **One template per build.** Multi-template flyers (hero card + small card)
    are built as two runs with the Page filter.
12. **The Sheets pipeline is untouched.** Both pipelines run in parallel from
    the same `buildOfferSheetRows` contract; retire the Sheet route whenever
    confidence is earned, by simply not using it.
