# Cirqle Studio — official Figma design companion for Cirqle

Replaces the pipeline

```
Cirqle → Google Sheet → Apps Script → Google Sheets Plugin → Figma
```

with

```
WhatsApp → Cirqle Studio (Figma) → Cirqle → back into Figma as cards
```

**without changing how designers design.** Figma remains the only design
environment. Cirqle never becomes a flyer builder — the plugin automates data
capture, cleanup and the repetitive duplication/fill work inside Figma.

## Folder structure

```
cirqle-studio/
├── README.md                 ← you are here
├── api/                      ← read-only reference copies of the deployed routes
│   ├── offers/route.ts       →  src/app/api/figma/offers/route.ts
│   └── campaign/route.ts     →  src/app/api/figma/campaign/[id]/route.ts
├── plugin/
│   ├── manifest.json         ← import THIS in Figma
│   ├── ui.html               ← sidebar UI + all network calls + the table
│   ├── src/code.ts           ← main-thread TypeScript (document work)
│   ├── src/figma.d.ts        ← minimal typings (swap for @figma/plugin-typings)
│   ├── dist/code.js          ← prebuilt — no build step needed to install
│   └── package.json          ← `npm run build` to recompile after edits
├── scripts/
│   └── validate-figma-api.sh ← one-command live API validation
└── docs/
    ├── INSTALLATION.md
    ├── TESTING.md
    ├── LIMITATIONS.md
    ├── ROADMAP.md
    └── VALIDATION_REPORT.md
```

Live server routes (in the app, not this folder):
`/api/figma/offers`, `/api/figma/campaign/[id]`, `/api/figma/parse`,
`/api/figma/campaign` (POST).

## The two tabs

### Build — offers already in Cirqle → cards

Client ▸ Offer ▸ Template ▸ Page, then **Build Flyer**. Cards are cloned from
your template into a new frame on the current page, filled by layer name.

**Fill selected cards** (checkbox): instead of creating new cards, pour the
data into cards already laid out on the page — the Google Sheets Sync
behaviour. Cards are matched in reading order (top row left-to-right, then
down), *not* click order. Extra selected cards are left untouched rather than
blanked.

### Paste offer — WhatsApp, Sheets, Excel or CSV → Cirqle → cards

1. Paste the list. Any of these work:
   - copied cells from **Google Sheets** or **Excel** (tab-separated),
   - the text of a **CSV** file,
   - a raw **WhatsApp** message.
2. **Split to columns** — instant, deterministic, nothing sent anywhere. Or
   **Parse with AI** for loose WhatsApp text with `Sunday 100gm` section
   headers, day grouping and `Sunday 3 page` hints.
3. Fix it in the table — see below.
4. **Save to Cirqle** → the offer is stored properly (change log, catalog,
   sheet sync) and auto-loads into the Build tab.

Save-then-build is deliberate: a list that only ever lived in a Figma file
would have no history and be invisible to the team.

#### What Split to columns does, exactly

The delimiter is decided for the **whole paste** first, then per line, because
one line on its own is often ambiguous — `Cashew 240,93,120` is three columns
while `Rice 1,250` is one product at twelve-fifty, and only the surrounding
rows say which is which.

| Input | Read as |
|---|---|
| Any tab present | Sheets / Excel clipboard. **Blank cells keep their position** — dropping one would shift every value after it into the wrong role. |
| Uniform commas, or a quoted cell | CSV. `"Rice, broken",44,60` is three cells. |
| Two or more spaces | WhatsApp columns: `MAMYPOKO XL22/L28    305    399`. |
| Trailing numbers | `Pista 149` → name + price. |
| A comma between digits | Never a delimiter. `1,250` → 1250, `11,50` → 11.50. |

**Section headers are handled without AI.** A line that is only a day
(`Monday`), only a pack size (`500gm`, `500 GMS`), or both (`Sunday 100gm`,
either order) is treated as a heading, not a product: it is removed from the
list and its pack size sticks to every line beneath it until the next header.
So a message with `Monday / 500gm / …22 items… / Monday / 100gm / …22 items…`
splits into 44 products with the right weight on each, and a multi-day paste
is flagged before you save. A real Weight column always wins over the header.
Spreadsheet pastes skip this entirely — a cell reading "Monday" is data.

**Header rows are read.** Paste your sheet *with* its header and the column
roles configure themselves: `Product · SALE · price A · MRP` becomes
Product / Price / **Ignore** / MRP — the duplicate empty `price A` claims
nothing, so the real MRP still lands in MRP. MRP is matched before Price
(a column headed "MRP Price" is an MRP), and the header row itself is never
saved as a product. Every dropdown stays editable; nothing is guessed
irreversibly.

## When a layer isn't inside the card

Names, photos, prices — any of them can be pulled out of the card into their
own component so they can be moved freely. Layers found outside the cards bind
two ways, and the two can be mixed on one page:

| | How it binds |
|---|---|
| `#product`, `#imageurl`, … | **Reading order.** 1st on the page → product 1, 2nd → product 2. Each layer name is ordered on its own, so photos in one container and names in another still line up. Layer-panel order is ignored; only canvas position counts. |
| `#product-3`, `#imageurl-3` | **That exact product.** Also `#product_3` or `#product 3`. Position is irrelevant — move it anywhere. |

A name appearing exactly once (`#offertitle`, `#client`, `#offerdate`) is read
as a page heading and filled once, not per product.

How many products fit on a page is decided by whichever layer name repeats
most — normally `#product`, but if the names are pulled out it falls to
`#imageurl`, then `#price1`. So a page whose only repeated layer is the photo
is still read as an N-slot page rather than duplicated N times.

`#price1` and `#price2` are unaffected — the separator is required, so they
stay the rupee/paise pair rather than becoming "`#price` number 1 and 2".

## Starting a template — ＋ New card template

The Build tab can generate one. It creates a component set, **Cirqle Product
Card**, on the current page with 12 variants:

| Property | Values |
|---|---|
| `Offer` | `Price` · `B1G1` · `Percent` |
| `Shape` | `Circle` · `Pill` |
| `Price` | `Whole` · `Paise` |

Modelled on the real flyers, not on a generic web card: no container box (the
card sits on the flyer background), a cut-out photo, the price badge
overlapping its bottom-right, the struck `#mrp` **inside** that badge above
the price, and `#product` / `#weight` in bold underneath.

Nothing is fixed-width — the badge hugs its text, so a circle becomes an oval
at ₹2359.50 rather than clipping, and the decimal point sits inside the price
group so it vanishes with `#price2`. Restyle everything: colours, radius,
fonts, photo shape. The plugin only reads the `#` names.

Generating one takes a Figma **desktop** session (development plugins don't run
in the browser), but the component then lives in the file and can be used
anywhere afterwards.

## The review table

The panel widens to 720px on this tab. Columns mirror the client's own review
sheet: `#` · Product · **SALE** · MRP · Weight · **P1·P2**.

| Tool | What it does |
|---|---|
| **AA / Aa / Aa Bc** | UPPERCASE · First letter capital · Title Case. Byte-identical to `src/lib/format-product-name.ts`. |
| **Trim** | Collapse repeated spaces. |
| **⇄ SALE/MRP** | Swap the two columns when a client sends them the other way round. |
| **+ Weight → name** | `Cashew 240` + `100gm` → `Cashew 240 100 gm`. Idempotent. |
| **+ Row / Delete** | Add a blank row; delete ticked rows. |
| Column dropdowns | Re-map which split column is Product / Price / MRP / Weight / Badge / Ignore. |

Bulk tools act on ticked rows, or on everything when nothing is ticked.
`Enter` moves down the same column, like a spreadsheet.

### Prices

`parsePrice` reads what clients actually write: `₹350`, `265/-`, `@ 145`,
`35rs`, `109.90`. Commas are resolved by digit count — `1,250` is a thousands
separator (1250), `11,50` is a decimal comma (11.50).

Prices normalise on blur so a half rupee is never ambiguous: **`11.5` → `11.50`**,
while whole rupees stay whole (`11`, not `11.00`).

The **P1·P2** column shows exactly what `#price1` / `#price2` will receive —
`11·50`, or `305·—` when there are no paise (the paise layer is then hidden
rather than printed empty). This mirrors `splitPrice()` in
`src/lib/offer-sheet.ts` exactly.

## Template compatibility

Layer matching uses the convention Cirqle already documents — `#` + column
name, lowercased, no spaces (`#product`, `#offerprice`, `#mrp`, `#imageurl`,
`#price1`, `#price2`, `#offerdatedisplay`) — **plus** forgiving aliases
(`#name`, `#price`, `#image`, `#photo`, `#badge`, `#oldprice`). Matching is
case-insensitive and whitespace-tolerant.

**Existing Sheets-plugin templates work without renaming a single layer.**

Validate warns about the traps: no `#product`, an `#imageurl` that is a text
layer, `#price1` without `#price2` (paise would vanish silently), and having
both `#offerprice` and the `#price1`/`#price2` pair (price printed twice).

## Data parity guarantee

`/api/figma/campaign/[id]` returns rows from the same `buildOfferSheetRows()`
that fills the Google Sheet, so a flyer built by Cirqle Studio is
field-for-field identical to one built via the Sheet — including split
Price 1 / Price 2 and both bindable date strings. The two pipelines cannot
drift apart.

## What Phase 1 does NOT do (by design)

No AI image generation. No Google Sheets dependency. No copy/paste through a
spreadsheet. No edits outside the current Figma page. See `docs/LIMITATIONS.md`
for hard platform limits and `docs/ROADMAP.md` for what comes next.
