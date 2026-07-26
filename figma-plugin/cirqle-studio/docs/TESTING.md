# Testing guide

Two suites: the **API** (scripted, one command) and the **plugin** (manual —
Figma dev plugins only run inside the Figma desktop app).

Reference scenario throughout: **Sea Star Supermarket**, 22-product weekly
offer, all whole-rupee prices, two BOGO badges, one product photo.

---

## 1 · API — scripted

```bash
export CIRQLE_SECRET='<Apps → Offer Intake → Shared sync script → secret>'
bash figma-plugin/cirqle-studio/scripts/validate-figma-api.sh
```

Covers: no-auth 401, wrong-token 401, valid-token 200, campaign shape (all
nine product fields), the 17-column bindings contract, row/product alignment,
unknown-campaign 404, and response times. Exit 0 = all pass.

Manual spot-checks for the two POST routes:

```bash
# parse — section headers, day grouping, page hints (read-only, saves nothing)
curl -s -X POST https://app.cirqle.work/api/figma/parse \
  -H "Authorization: Bearer $CIRQLE_SECRET" -H 'Content-Type: application/json' \
  -d '{"text":"Sunday 100gm\n\nCashew 240  93\nPista 149\n\n1kg\n\nAvil 59\n\nSunday 3 page"}' | head -c 600
# expect: summary "…3 section(s) · days: Sunday · packs: 100gm, 1kg · pages: Sunday=3"

# both POST routes must fail closed
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.cirqle.work/api/figma/parse    # → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.cirqle.work/api/figma/campaign # → 401
```

---

## 2 · Plugin — Build tab

Pre-flight: a card on the **current page** with `#product`, `#offerprice`,
`#mrp` text layers and an `#imageurl` shape.

| # | Step | Expected |
|---|------|----------|
| 1 | URL + token → **Connect** | Chip **Connected**; Client fills. Token field is masked. |
| 2 | Sea Star → Offer dropdown | The weekly offer, "· 22 products". |
| 3 | **Load Offers** | Chip **22 Products**; Page dropdown fills. |
| 4 | **Preview** | 22 rows: page, name, price, MRP, badge, image ✓/—. Spot-check Mamypoko 305/399, Sunplus 409/499, Santoor Hand Wash badge `B1G1`. |
| 5 | **Validate** | Data + template checks with fixes. Expect a WARNING (21 products have no photo → placeholders), not an error. |
| 6 | **Build Flyer** | New frame on the current page, 22 cards in a grid. Existing artwork untouched. |
| 7 | Card contents | names ✓ prices ✓ MRPs ✓ badges on the BOGO items ✓ one real photo ✓ gray placeholders elsewhere ✓ empty values hide their layer (no floating strikethrough). |
| 8 | Log | "22 cards built, N layers filled, N images placed, 21 placeholder(s)". |

### Fill selected cards

| # | Step | Expected |
|---|------|----------|
| 9 | Select 5 existing cards (click them out of order deliberately), tick **Fill selected cards**, Build | Data lands in **reading order** — product 1 in the top-left card, not the first-clicked. Nothing moves. |
| 10 | Select 30 cards for a 22-product offer | 22 filled; the extra 8 **left untouched**, not blanked. Log says so. |
| 11 | Select 10 cards for a 22-product offer | 10 filled; log warns "12 product(s) had no card to go in". |

---

## 3 · Plugin — Paste tab

| # | Step | Expected |
|---|------|----------|
| 12 | Switch to **Paste offer** | Panel widens to ~720px. |
| 13 | Paste a message with `Sunday 100gm` … `1kg` … `Sunday 3 page`, press **Parse with AI** | Log shows "N product lines · N section(s) · days: … · packs: … · pages: Sunday=3". Weight column filled per section. Day separators in the table. |
| 14 | Paste the same, press **Split to columns** | Instant, no AI. Column-role dropdowns appear above the table. |

### Manual paste — spreadsheet, CSV, WhatsApp (no AI)

Everything here uses **Split to columns**. Nothing leaves the machine.

| # | Step | Expected |
|---|------|----------|
| 14a | In Google Sheets select `Product · SALE · price A · MRP` **including the header row**, copy, paste, **Split** | Log: "…Columns read from your header row (Product · SALE · price A · MRP)". Dropdowns read Product / Price / **Ignore** / MRP — the empty `price A` claims nothing, and MRP lands in MRP rather than being shifted a column left. The header itself is not a product row. |
| 14b | Same selection **without** the header | Falls back to position: Product / Price / MRP / Weight. Blank cells still hold their place. |
| 14c | Copy the same range from Excel | Identical result — both apps put tabs on the clipboard. |
| 14d | Paste a CSV file's text, `Product,SALE,MRP` first line | Header read the same way. `"Rice, broken",44,60` stays three cells, the comma kept inside the name. |
| 14e | Mixed WhatsApp text: `Cashew 240  93`, `Pista 149`, `Rice Ponni 11,50`, `Rice Basmati 1,250` | Four rows. `11,50` → **11.50**, `1,250` → **1250**. A comma between digits never splits a line. |
| 14f | Paste only a header row | Refused: "Only a header row was pasted." |
| 15 | Change a column dropdown (e.g. Price → MRP) | Rows re-derive immediately. |
| 16 | Tick 3 rows → **AA**, then **Aa Bc** | Only those names re-case. Untick all → tools apply to every row. |
| 17 | **+ Weight → name** | `Cashew 240` → `Cashew 240 100 gm`. Press again: no change (idempotent). |
| 18 | Type `11.5` in SALE, press Tab | Field shows **`11.50`**; P1·P2 column shows **`11·50`**. |
| 19 | Type `11.05` | P1·P2 shows `11·05` — distinct from the above. |
| 20 | Type `1,250` | Parsed as 1250, not 250. |
| 21 | Whole-rupee price e.g. `305` | P1·P2 shows `305·—`; after building, the `#price2` layer is **hidden**, not blank. |
| 22 | **Save to Cirqle** | "Saved N products to <client>"; auto-reloads, selects the campaign, jumps to Build. Verify it appears in Cirqle → Requests. |
| 23 | Paste a two-day message → Save | **Blocked** with an explanation to save one day at a time. |

---

## 4 · Failure drills (the never-crash contract)

Every failure must state **what**, **where**, and **how to fix** — never a
blank panel:

| Scenario | Expected message |
|---|---|
| Wrong token | "Authentication failed [/api/figma/offers]" + where to get the secret. |
| Server unreachable | Names the two real causes (middleware redirect / manifest CSP) and how to check the console. |
| Template deleted after selection | Build refuses, suggests Refresh. |
| No template selected | "No template selected" + pick-or-Refresh. (Not required in Fill-selected mode.) |
| One broken image URL | That product gets a placeholder + a named log line; the other 21 cards still build. |
| Archived campaign | 404 with "Refresh the offer list". |
| Groq rate limit mid-parse | Section reports "AI rate limit hit — wait ~30s and press Parse again", other sections still return. |
| Template with `#price1` but no `#price2` | Validate warns the paise would be dropped silently. |

---

## 5 · Unit tests (in the app repo)

```bash
npm test
```

`src/lib/ai/offer-sections.test.ts` (11 tests) covers the section parser
against verbatim Sea Star messages: combined `Sunday 100gm` headers, both
header orders, mid-message pack changes, two-day splits, page hints, spaced
pack sizes (`500 GMS`), and products that merely look like weights
(`Chips 129`).
