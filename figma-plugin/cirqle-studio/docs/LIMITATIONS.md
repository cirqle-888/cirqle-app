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

## Template shape (read this before the first build)

A template is either a **single product card** or a **whole page** already
laid out with N product cards. The plugin counts `#product` layers to tell
which, and the dropdown says so: "1 card" or "22 product slots".

- **1 card** → one copy per product, arranged in the Columns/Gap grid.
- **N slots** → one page per N products, filled top-left to bottom-right.
  Offer-level layers outside the cards (`#offertitle`, `#offerdate`,
  `#client`, `#pagenumber`) are filled once per page. Leftover slots on the
  last page are **hidden**, not deleted or left showing sample data.

Slot boundaries are found by climbing from each `#product` layer until the
next step up would swallow a second product — no naming convention beyond
the `#` layers already in use. Reading order uses absolute position, so
groups nested at different depths still sort correctly.

### When a layer lives outside its card

Designers pull parts out of the card into their own component so they can be
nudged around freely — the name, the photo, or both. Any `#` layer found
outside the cards is bound in one of two ways:

- **By reading order.** The 1st `#product` on the page takes product 1, the
  2nd takes product 2, and so on. Each layer name is ordered independently, so
  photos in one container and names in another still line up. Layer-panel order
  is irrelevant — only position on the canvas counts.
- **By an explicit number** — `#product-3`, `#imageurl-3` (also `_3` or ` 3`)
  always takes product 3, wherever it sits. Use this when reading order isn't
  what you mean.

The slot count comes from whichever anchor layer repeats most: `#product`,
then `#imageurl`, `#price1`, `#offerprice`, `#mrp`, `#weight`. `#product` wins
ties, so nothing changes for ordinary card templates — but a page whose only
repeated layer is the photo is still recognised as an N-slot page instead of
being duplicated N times.

A name that appears exactly **once** is treated as a heading for the page —
`#offertitle`, `#client`, `#offerdate` — and filled from the first product on
that page rather than repeated per product.

The separator is required, which is what keeps `#price1` and `#price2` reading
as the rupee/paise pair rather than as "`#price` number 1" and "number 2".

This was the first real-run failure: an A4 page with 22 `#product` layers
was treated as one card, so the page was duplicated 22 times with the same
name stamped into all 22 of its slots. 484 layers filled, every one wrong.

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
