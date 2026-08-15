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

Pre-flight: a card on the **current page** with `#product`, `#price1`
(plus `#price2` for paise), `#mrp` text layers and an `#imageurl` shape —
exactly what **+ New card template** generates, so pressing that button is
the fastest way to set this up in an empty file. (`#offerprice` is the
single-field alternative to the `#price1`/`#price2` pair, not a requirement.)

| # | Step | Expected |
|---|------|----------|
| 1 | URL + token → **Connect** | Chip **Connected**; Client fills with **every active client in the workspace**, not only those with an offer open. Token field is masked. |
| 1a | Connect to a workspace with **zero** active campaigns | Client still fills; Offer shows `— no active offer for this client —`; a paste can be saved and becomes the first campaign. (Regression guard: this used to be an unbreakable deadlock.) |
| 2 | Sea Star → Offer dropdown | The weekly offer, "· 22 products". |
| 3 | **Load Offers** | Chip **22 Products**; Page dropdown fills. |
| 4 | **Preview** | 22 rows: page, name, price, MRP, badge, image ✓/—. Spot-check Mamypoko 305/399, Sunplus 409/499, Santoor Hand Wash badge `B1G1`. |
| 5 | **Validate** | Data + template checks with fixes. Expect a WARNING (21 products have no photo → placeholders), not an error. |
| 6 | **Build Flyer** | New frame on the current page, 22 cards in a grid. Existing artwork untouched. |
| 7 | Card contents | names ✓ prices ✓ MRPs ✓ badges on the BOGO items ✓ one real photo ✓ gray placeholders elsewhere ✓ empty values hide their layer (no floating strikethrough). |
| 8 | Log | "22 cards built, N layers filled, N images placed, 21 placeholder(s)". |

### Variants

Pre-flight: a price sticker built as a component set with a `Digits` property
(`1`/`2`/`3`/`4`), used as an instance inside the card.

| # | Step | Expected |
|---|------|----------|
| 8a | Pick that template | A **Variants** panel appears listing `Digits`, defaulting to "Auto — price digits". |
| 8b | Build | `₹5` uses `Digits=1`, `₹44` uses `2`, `₹209` uses `3`. Log: "N variant instance(s) switched". |
| 8c | Remove the `4` variant, build with a ₹2359 product | Takes `Digits=3` — the widest — rather than clipping. |
| 8d | Set `Digits` → **Always "3"** and rebuild | Every card uses `3`, whatever the price. The choice survives closing the plugin. |
| 8e | Set `Digits` → **Leave alone** | Cards keep the variant they had; nothing counted as switched. |
| 8f | A property named `Theme` | Shown as "Auto — name not recognised" and never changed unless pinned. |
| 8g | A Malayalam product name with a `Script` property (`English`/`Malayalam`) | Picks `Malayalam`. A name with both scripts picks `Mixed` if that variant exists. |
| 8h | `Digits` = `0.00 / 00.00 / 000.00 / 0000.00 / 00000.00` | `₹5`→`0.00`, `₹44`→`00.00`, `₹209`→`000.00`, `₹2359`→`0000.00`, `₹12500`→`00000.00`. |
| 8i | One property carrying both `00` and `00.00` | `₹44` takes `00`; `₹62.50` takes `00.00`. The paise break the tie. |
| 8j | `Decimal` = `Yes`/`No` (or `True`/`False`, `Whole`/`Decimal`, `With`/`Without`) | Follows whether the price has paise. |
| 8k | `Has price` = `Yes`/`No`, with a B1G1 product carrying no price | Picks `No`. Same for a product whose offer text is `50 % SALE`. |
| 8l | Same no-price product, with a `Digits` property present | `Digits` is **left untouched** — no width is guessed from a price that doesn't exist. Log shows it wasn't counted as switched. |
| 8m | A set whose property is Figma's default `Property 1` | Listed as `<set name> · Property 1` with its values underneath, and "Auto — name not recognised". |
| 8n | Set it to **Use: price digits ✓ fits** | Switches by width from then on, with no renaming in Figma. Survives reopening the plugin. |
| 8o | Two sets both using `Property 1` (e.g. Price and PRODUCT) | Two separate rows; mapping one does not affect the other. |
| 8p | Values named `Outline 0 Cut` / `Outline 00` / `Outline 000` | Read as 1 / 2 / 3 digits — a run of zeros anywhere in the name counts. |
| 8q | Load the Goodwill weekly offer, then look under the mapped property | Group rows appear: **3 digits · 6 products**, **2 digits · 9**, **no price · 7**. Switch the property to paise and it reads **whole rupees · 14**, **has paise · 1** (Grandmas Sauce). |
| 8r | Set `3 digits → Outline 000`, `2 digits → Outline 00`, `no price → Outline Best Buy`, build | Exactly 6 / 9 / 7 cards on those variants. |
| 8s | Point a group at a variant auto would not have chosen | The group mapping wins. |
| 8t | Change the Page dropdown | Group counts re-read for that page only. |

### Fill selected cards

| # | Step | Expected |
|---|------|----------|
| 9 | Select 5 existing cards (click them out of order deliberately), tick **Fill selected cards**, Build | Data lands in **reading order** — product 1 in the top-left card, not the first-clicked. Nothing moves. |
| 10 | Select 30 cards for a 22-product offer | 22 filled; the extra 8 **left untouched**, not blanked. Log says so. |
| 11 | Select 10 cards for a 22-product offer | 10 filled; log warns "12 product(s) had no card to go in". |

### Bulk product shots (⇈ Shots)

Pairing is the whole feature: a photo filed under the wrong product is
invisible until a flyer goes out with it, so **nothing uploads until the
table has been looked at**.

| # | Step | Expected |
|---|------|----------|
| 8u | Select ~20 loose cut-outs named after their products, press **⇈ Shots** | A pairing table: thumbnail, matched product name, layer name, and a row dropdown each. Header reads "N photos · N paired · N waiting for you". |
| 8v | A cut-out named `Cashew 240` against the row `Cashew 240 100 gm` (after **+ Weight → name**) | Matched. Token overlap is scored against the *shorter* name, so the added weight doesn't break it. |
| 8v-1 | A legacy flyer cell: layer called `Group 9685`, with the text `NESTLE MILKYBAR 75GM` inside it | Matched. When the layer name is one of Figma's own (`Group`/`Frame`/`Image`/`Object`/`Rectangle`/`Mask group`…), the most name-like **text** inside the node is used instead — that text is the only real identifier in an untagged file. |
| 8v-2 | A cut-out with no text inside it at all | **Unmatched** — nothing to read, so it waits for the designer. |
| 8v-3 | A cell whose longest text is a badge (`BUY 1 GET 1 FREE`) | Harmless: the badge matches no product row, so the photo stays unpaired rather than landing on the wrong product. |
| 8w | A layer named `Image 12` / `Group 8504` | **Unmatched**, dropdown outlined amber, never uploaded. |
| 8x | A photo whose name matches two rows equally (`Rice` against `Rice Ponni` + `Rice Basmati`) | **Unmatched** — a tie is refused rather than guessed. |
| 8y | Two photos that both match one row | The first claims it; the second is left unmatched. |
| 8z | Select a built flyer card, or a whole block of them | Each card's `#imageurl` is a photo and its `#product` **text** names it — a finished flyer pairs itself with no renaming. Order is reading order. |
| 8aa | Select the generated `Cirqle Product Card` component set | 12 photos found, hint `Product Name` on each, **0 paired** (placeholder text matches nothing) — proof the hold-back works. |
| 8ab-1 | Press **Pair in order** | Photo 1 takes row 1, photo 2 row 2, and so on, in reading order. Any photo past the end of the sheet stays unpaired and the log says how many. This is the fast path for legacy flyers, where no layer carries a product name. |
| 8ab | Pair one by hand from the dropdown | Amber outline clears, the header count moves, and the button becomes "Upload 1 paired photo". |
| 8ac | Press Upload with one photo deliberately broken | The batch continues; the failed row keeps its reason on the line, the log says how many failed, and pressing Upload again does **not** re-upload the ones that worked. |
| 8ad | Upload with no client selected | Refused with "pick the client at the top of the Build tab". Scanning and pairing still work without one — only the upload needs it. |
| 8ae | After a successful batch | Each row carries its new photo into the next **Save to Cirqle**, and the photos turn up in **+ Catalog** search. |

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
| 14d-1 | CSV where ONE name is quoted because it holds a comma, e.g. `Product,SALE,MRP,Weight` / `Cashew 240,93,120,100gm` / `"Rice, broken",44,60,1kg` | All rows split into 4 columns. Regression guard: the quoted comma used to make the block's comma counts uneven, the whole paste fell back to loose text, and **`Cashew 240,…` collapsed into one cell** — name mangled, price silently lost. |
| 14d-2 | A ragged CSV (one row has an extra cell) | Rows still split; any row that came out the wrong width but reads as CSV at the block's width is re-read, and the log says `N row(s) read as CSV — their names end in a number.` |
| 14e | Mixed WhatsApp text: `Cashew 240  93`, `Pista 149`, `Rice Ponni 11,50`, `Rice Basmati 1,250` | Four rows. `11,50` → **11.50**, `1,250` → **1250**. A comma between digits never splits a line. |
| 14f | Paste only a header row | Refused: "Only a header row was pasted." |
| 15 | Change a column dropdown (e.g. Price → MRP) | Rows re-derive immediately. |
| 16 | Select 3 rows (click their row numbers) → **AA**, then **Aa Bc** | Only those rows re-case — name and weight. Click empty space/Esc to clear the selection → tools apply to every row. |
| 16a | Click a cell, type, **Enter** | Value replaced; the cursor moves down a row, like Sheets. |
| 16b | Select a 2×3 range, **⌘C**, paste into Google Sheets | Lands as 6 separate cells. Copy a block back from Sheets, **⌘V** on a cell here | It lands from that cell, adding rows if it runs past the end. |
| 16c | **⌘Z** after any of the above | Exactly one step undone; **⇧⌘Z** redoes. |
| 16d | Select a column of Weight cells, type `100gm`, **Enter**, reselect, **⌘D** | The value fills down the selection. |
| 16e | Select row 2, press **+ Row** | A blank row lands BETWEEN rows 2 and 3, selected and ready to type — not at the end. |
| 16f | Select 3 rows, right-click → **Insert 3 rows above** | Three blank rows land above the selection. **⌘Z** removes all three at once. |
| 16g | Right-click the SALE header → **Insert column left** | The add-column box opens; the new column lands between Product and SALE, and copy/paste follows the new order. |
| 16h | Right-click a custom column → **Remove column** | Column disappears; its values stay on the rows (re-add the name to see them). |
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
