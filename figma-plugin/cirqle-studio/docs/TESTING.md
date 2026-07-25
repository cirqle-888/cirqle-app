# Testing guide — Sea Star Supermarket, 22-product weekly offer

Sea Star's live campaign (22 products, prices + MRPs, two BOGO badges) is the
reference scenario. Run this end-to-end after deploying the API routes.

## Pre-flight

- API routes deployed; `npx tsc --noEmit` and `npm run build` were green.
- Sea Star has an ACTIVE campaign (Offer Intake shows it Ready).
- A Figma file with a product-card template on the current page. The card
  needs at least: a text layer `#product`, a text layer `#offerprice`, a text
  layer `#mrp`, a rectangle/frame `#imageurl`, a text layer `#badges`.

## Test script

| # | Step | Expected |
|---|------|----------|
| 1 | Open plugin, enter URL + token, **Connect** | Chip: **Connected**. Log: "Connected. N active offers." No password/secret visible (token field is masked). |
| 2 | Client dropdown | "Sea Star Supermarket" listed. |
| 3 | Select Sea Star → Offer dropdown | The weekly offer with "· 22 products". |
| 4 | **Load Offers** | Chip: **22 Products**. Log names the campaign and client. Page dropdown fills (All pages / Page 1). |
| 5 | **Preview** | 22-row table: page, name, price, MRP, badge, image ✓/—. Spot-check: Mamypoko 305/399, Sunplus 409/499, Blue Wash badge "Buy 1 Get 1", Santoor Hand Wash badge "B1G1". |
| 6 | **Validate** | Data checks + template checks listed with fixes. With photos missing in Cirqle, expect a WARNING (placeholders), not an error. Chip: **Ready** or **Ready (warnings)**. |
| 7 | **Build Flyer** | Progress bar runs (image download → card build). A new frame "Sea Star Supermarket — <offer>" appears on the CURRENT page containing 22 cards in a grid. Existing nodes untouched. |
| 8 | Card contents | ✓ names filled · ✓ prices filled · ✓ MRPs filled · ✓ badges appear on the two BOGO items · ✓ photos placed where an Image URL existed · ✓ gray placeholder where missing. Empty values HIDE their layer (no floating strikethrough). |
| 9 | Log report | "22 cards built, N layers filled, N images placed, N placeholders." Missing-layer warnings only for columns the template genuinely lacks. |
| 10 | **Refresh** | Re-scans templates, re-fetches offers and the campaign without losing selections. |

## Failure-path tests (error handling contract)

Each failure must state **what failed, where, and how to fix it** — never a
blank screen, never a crash:

- Wrong token → "Authentication failed [GET /api/figma/offers]" + fix line.
- Wrong URL / server down → "Could not reach the server" + fix line.
- Template deleted after selection → Build refuses with a Refresh hint.
- One broken image URL → that product gets a placeholder + a named log line;
  the other 21 cards still build.
- Offer archived mid-session → campaign fetch returns a 404 explanation.

## API smoke tests (curl)

```bash
SECRET='<shared secret>'
curl -s -H "Authorization: Bearer $SECRET" https://app.cirqle.work/api/figma/offers | head -c 400
# → {"ok":true,"offers":[{"clientName":"Sea Star Supermarket","productCount":22,...

curl -s -o /dev/null -w '%{http_code}\n' https://app.cirqle.work/api/figma/offers
# → 401   (no token: fail closed)
```
