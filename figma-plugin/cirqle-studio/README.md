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

## Sign in once, work as yourself

The plugin signs in with the employee's own Cirqle credentials (email or
CQID + password) against `POST /api/figma/login` — a new app route that
verifies the password via Supabase auth and returns the workspace token
plus the employee's identity. The plugin keeps only those (never the
password). From then on:

- the header shows the signed-in **CQID**, never a name ("CQID001 ·
  app.cirqle.work") — the panel sits open on shared screens, so the login
  route returns only `{ id, cqid }` and a session stored by an older build
  is stripped of any name on load,
- every offer saved from Figma creates (or reuses) **one task per campaign**
  on the Tasks page — titled with the *offer title*, linked to the client,
  tracked by a `[figma:cmp:<id>]` marker in the description, and everyone
  who saves that offer is added via `task_assignments`,
- **contribution counts fill themselves**: on the first save the employee's
  "Products" count is the product total; on a re-save the *differences* are
  attributed to whoever saved — changed prices/MRPs bump their
  "Price Updating", changed names bump "Product Name Updating", and added
  products bump "Products". After every build the plugin also reports
  pages + creatives (`POST /api/figma/build-report`), which SETS the
  employee's "Pages"/"Creatives" counts (rebuilds don't inflate them).
  Parameters are matched by name against the workspace's own contribution
  setup, so this adapts to renames and skips anything missing; the
  contribution panel remains the manual override for all of it,
- the old shared-secret path still exists under "Advanced — shared secret"
  for manual/edge cases.

Server routes in the app: `src/app/api/figma/login/route.ts`,
`src/app/api/figma/build-report/route.ts` (both new) and
`src/app/api/figma/campaign/route.ts` (task + contributions — always
best-effort, a hiccup never fails the offer save or the build).

## Interface: the plugin resumes, you build

Explanations stay out of the way: the Variants panel shows one short line
per property instead of repeating a paragraph under each, long instructions
live behind a collapsed **How auto picks**, and a set's variant values are
listed as the first few plus "+N more" (full list in the tooltip).

The main interface only shows the decision that's actually in front of you —
everything set-once lives behind folds, and everything from last session
comes back on its own (all persisted per user via `figma.clientStorage`):

- **Auto-connect** — after the one-time sign-in the plugin connects on
  open; the sign-in card only reappears when connecting fails.
- **Picking is loading** — there is no Load Offers button: choosing a
  client or offer loads it (a sequence guard drops stale responses when
  selections change quickly), and the sheet fills itself. The old "Edit
  offer in sheet" button is gone too — the Paste tab always holds the
  loaded offer. Manual paths that remain: ↻ re-scan/reload, and the
  Advanced shared-secret connect.
- **Resume last offer** — the last client, offer and template are
  reselected, and if that offer is still active it is loaded immediately:
  open plugin → press Build Flyer. Templates are remembered by *name*, so
  the memory survives re-scans and travels between files.
- **Layout fold** — Page / Order / Columns / Gap / Fill-selection collapse
  to a one-line summary ("4 col · gap 40 · All pages · Cirqle order").
  Values and the fold's open state persist.
- **Activity fold** — the log collapses to its latest line under the status
  chips, and pops open automatically whenever an error needs the full
  what/where/how-to-fix story.
- **Contextual hints** — the template how-to shows only while the page has
  no template; the AI-hint field lives behind "AI options" on the Paste tab.
- The last-used tab (Build / Paste offer) is also restored.
- **Tag layers** — select any layer on the canvas and click the #token it
  holds (#product, #price1, #mrp, #imageurl, …); the plugin renames it, and
  for a component-set template it renames the matching layer in **every
  variant** in one click. Tokens the current template is still missing are
  highlighted, and the panel opens itself whenever validation reports a
  template problem. Text tokens refuse shapes (and #imageurl refuses text)
  with a pointer to the right layer, and renames inside *instances* are
  rejected — tag the main component so the template actually changes.
  Aliases now also accept "price a" / "price b" for #price1 / #price2.
- **Default variant** — when the template is a component set, a "Default
  variant" selector picks which variant new cards start from (instead of
  silently using Figma's default). Remembered per template name; the
  per-product variant mapping still overrides whatever properties it maps.
- Dropdowns show only the template's *name*; the technical details
  ("1 card · 3 fields") sit in a muted hint beside the label.
- **Column gap and row gap are separate** — the Layout fold has both, each
  remembered, summarised as "gap 10×24" when they differ.
- **Card variants** — with an offer loaded and a component-set template, a
  per-product list pins any product's card to a specific variant. "Auto"
  keeps the mapping-driven switching; a manual pin is applied after it, so
  it always wins. Picks are per-offer (cleared when a different offer
  loads) and follow the product through any build order.
- **Sample-based variant matching** — when variant names carry no meaning
  ("Variant 2", "Variant 7"), the automatic switching reads each variant's
  own sample price instead. Sequence-number names are explicitly *not*
  read as widths (`digitWidthOf` rejects `default|variant|type|style|…`
  followed by digits): "Variant2" used to parse as "2 digits" and
  "Variant10" as "10 digits", which both sent products to the wrong
  sticker and — because it counted as a match — stopped the sample
  fallback from ever running. The rules: the variant whose `#price1` shows `000` is used
  for 3-digit prices, one with no visible `#price2` serves whole-rupee
  products, and a variant with no price layers at all catches no-price
  offers (B1G1 etc). Exact digit width first, else the smallest roomier
  variant, else the widest — paise presence breaks ties. Runs only when
  name-based matching found nothing, and manual pins still override it.
  The "name language" fact groups Malayalam *and* Arabic as regional, so
  one mapping restyles every non-English product name at once. MRP is a
  fact too: products with an MRP get a variant whose sample shows a
  visible `#mrp` layer, products without one get the plain variant — and
  validation warns when the offer has MRPs but no variant can show one.
- **The sheet is always live** — loading an offer fills the editable
  spreadsheet automatically (unless it holds unsaved work for a different
  offer), and "Edit offer in sheet" jumps straight to it. Price fixes or
  product swaps from the client are edited there, saved back to Cirqle,
  and rebuilt — never hand-edited behind Cirqle's back.
- **Page planning in the sheet** — the **Pages** toolbar button shows two
  optional columns, *Category* and *Page*. With them:
  · **N per page → number all** numbers every product sequentially ("this
  page takes 16");
  · **new page at each category** makes the count a maximum instead, so a
  category never splits across pages;
  · select any rows and **set selected rows** puts that range on a page —
  "from this product to this product goes on page 3";
  · **sort by category** groups rows, keeping their order inside each group
  (uncategorised last).
  Category is filled automatically from the section the parser found a row
  under (a day, a weight like "100gm"), so an AI-parsed list arrives already
  categorised; it stays editable. Pages are saved to Cirqle with the offer,
  so the Build tab's Page filter — and anyone reopening the offer later —
  works from the plan.
- **One block per page** (Layout) — builds each page separately, one block
  beside the previous, instead of one grid for the whole offer. Runs the
  builds sequentially (the document work is single-threaded) and each block
  is named "… — Page N".
- **Variant column in the sheet** — when the selected template has
  variants, every sheet row ends with a Variant cell (Auto / pin), kept in
  step with the Build tab's Card variants panel. Like P1·P2 it sits outside
  the cell-selection model, so keyboard nav and copy-paste ignore it.
- **Drafts survive closing the plugin** — the sheet's unsaved rows, title,
  date and variant pins are stored in `figma.clientStorage` (debounced) and
  restored on reopen; saving to Cirqle replaces the draft with the
  server's canonical copy.
- **Free cards** — a Layout checkbox ("Free cards — no wrapper frame")
  builds cards straight onto the page in the same grid, each independently
  movable from the first second; all built cards come out selected. Off by
  default (the wrapper frame keeps big builds tidy); persisted.
- **Modular card templates** — a template can be a plain **Group** of
  separate components (product name + price tag + photo as three
  components, grouped per product). The group is the template: it scans,
  tags, validates and builds like any frame, and each sub-component's
  variants still switch per product.
- **Each piece is also its own template.** The pieces a card is built from
  are listed in the Template dropdown in their own right, labelled with the
  card they belong to ("Component 66 ▸ Price Tag"), so a build can place
  *only* the price tags over finished artwork, or *only* the product names.
  Selecting a piece that is a component set offers that set's own default
  variant.

  How the list is built (`scanTemplates`): top-level nodes are listed first
  and keep their plain name. Then every piece *inside* a card is resolved —
  Figma stores pieces as instances, so each is followed to the master (or
  its component set) that a build would actually clone, which also surfaces
  masters filed on another page. A master used inside exactly one card is
  then shown as that card's piece; one shared by several cards stays
  plainly named rather than claiming a card. Nested frames and groups stay
  out (structure, not reusable pieces), as do the variant children of a
  component set — the set itself is the template. Templates are remembered
  by this full label, so the choice survives a re-scan (node ids change)
  and two pieces named "PRODUCT" in different cards never collide.
- **Light theme by default**, with a ☾/☀ toggle in the header; the choice
  persists. Component-set templates are measured by ONE card (the chosen
  default variant), not the whole variant stack — row spacing now honours
  the row gap exactly.

## The two tabs

### Build — offers already in Cirqle → cards

Client ▸ Offer ▸ Template ▸ Page, then **Build Flyer**. Cards are cloned from
your template into a new frame on the current page, filled by layer name.

**Order**: lay the flyer out in a different sequence without going back to
Cirqle — the same orderings the app offers.

| Option | Behaviour |
|---|---|
| Cirqle order | Page, then position. The default; nothing is reordered. |
| Sale price — low to high / high to low | Sorts on `#price1`. Products with no price (Buy 1 Get 1, 50% off) always sit **last**, never treated as ₹0. |
| Category | Grouped by `offer_products.catalog_id → category`. Uncategorised products last. |
| Random shuffle | Fisher–Yates on a fixed seed, so **what Preview shows is what Build makes**. Press ↻ for a different roll. |

Equal prices and same-category products keep the order the client sent them.
Preview, Validate, Build and Fill-selected all walk the same list, so nothing
can drift between what you check and what you get.

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

   **Non-Latin lists — Malayalam, Hindi, Arabic, Tamil — must use Split.** It
   copies your text character for character, because no model ever sees it.
   Asked to tidy a name, an LLM rewrites `ചെറുപയർ 500GM` as `Cherupayar 500Gm`
   and the whole flyer prints in the wrong language. Three things now guard it:

   1. `src/lib/ai/offer-capture.ts` forbids translation and transliteration
      outright — this prompt is shared with Cirqle's own Offer Intake, so the
      app is covered too;
   2. **Parse with AI refuses** a non-Latin paste on the first press, before
      anything is sent. Press it again to override deliberately;
   3. if the names come back romanised anyway, the result is **discarded** and
      Split runs on the original text instead.

   Only the third can fail silently, so Split remains the recommendation.
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

## Variants that switch themselves

A sticker drawn for `44` is the wrong shape for `209`, and Latin type is the
wrong style for a Malayalam name. Build a variant set for each case and the
plugin picks per product — set once, then every card switches itself.

Five facts are read from the data:

| Fact | Comes from | Values |
|---|---|---|
| price digits | digits in the rupees (`#price1`), paise excluded | `1` … `6`, or *nothing* when there's no price |
| paise / decimal | whether `#price2` has anything | `yes` · `no` |
| has a price | whether there's a number at all | `yes` · `no` |
| offer type | `#offertype`, `#badges`, `#offertext` | `price` · `bogo` · `percent` |
| name language | Malayalam characters in `#product` | `latin` · `malayalam` · `mixed` |

A variant property is matched to a fact **by its name** — `Digits`,
`Price length`, `Char count`, `Price format` → digits; `Paise`, `Decimal` →
paise; `Has price`, `Price shown` → has a price; `Offer`, `Deal`, `Badge`,
`Type` → offer type; `Script`, `Language`, `Malayalam` → name language.

**Price masks are understood directly.** Name the variants the way the price
looks and nothing else is needed:

| Variant value | Read as |
|---|---|
| `0.00` | 1 rupee digit, with paise |
| `00.00` | 2 digits, with paise |
| `000.00` | 3 digits, with paise |
| `0000.00` | 4 digits, with paise |
| `00000.00` | 5 digits, with paise |
| `00` / `000` | 2 / 3 digits, no paise |

`#` and `X` masks read the same way. If one property carries both `00` and
`00.00`, the product's paise decide which — `₹44` takes `00`, `₹62.50` takes
`00.00`. Plain numbers and phrases still work too: `3`, `3 digit`, `Char count
= two`.

Values elsewhere are matched loosely: `B1G1`, `Buy 1 Get 1`, `Yes`, `True`,
`With`, `Whole`, `Decimal`, `Sale text`, `Malayalam` all land correctly.

**Products with no price** — a `BUY 1 GET 1 FREE` ribbon or `50 % SALE` printed
where the number normally goes — set *has a price* to `no`, so a property named
`Has price` (`Yes`/`No`) or `Price shown` (`Price`/`Sale text`) switches to the
text layout. Those products deliberately express **no opinion** about digits or
paise, so those properties keep whatever the designer set rather than being
guessed at from a price that isn't there.

### Mapping a property that isn't named helpfully

Figma names variant properties `Property 1` by default, and most templates
never get renamed. Nothing there tells the plugin what the property means, so
the panel lets you say it directly instead:

| Choice | What it does |
|---|---|
| **Auto — …** | Work it out from the property's name. |
| **Use: price digits** (and the other four) | This property means *that*, whatever it's called. No renaming in Figma. |
| **Leave alone** | Never touched. |
| **Always "X"** | Pinned to one value for every product. |

Facts whose values would actually work are listed first and marked **✓ fits**,
so the likely answer is usually the top one. Each property is listed as
`<component set> · <property>` and its values are shown underneath — with three
sets all called `Property 1`, that's the only way to tell them apart, and
mappings are stored per set so they can't bleed into each other.

Descriptive value names work too: `Outline 0 Cut`, `Outline 00`, `Outline 000`
are read as 1, 2 and 3 digits. A run of zeros anywhere in the name counts.

Choices are remembered between sessions. A property nothing recognises —
`Theme`, `Colour` — is never touched unless you pin it.

### Mapping each group of products to a variant

Once a property is pointed at a fact, the panel breaks the **loaded offer**
into the groups that actually occur and lets you aim each one. A real Goodwill
weekly list comes out as:

| Group | Products |
|---|---|
| 3 digits | 6 |
| 2 digits | 9 |
| no price | 7 |
| has paise | 1 |

Each row gets its own dropdown of that property's variants — set `3 digits →
Outline 000`, `2 digits → Outline 00`, `no price → Outline Best Buy` and the
build follows exactly that. Counts come from the offer you loaded, so if a
group is missing you know before building rather than after.

A group mapping beats automatic matching, and it's the only way to aim the
**no price** group, which the automatic path deliberately leaves alone. Leave a
row on *Auto* to let name matching handle it.

Two things have to be true before groups appear, and the panel says which one
is missing rather than showing nothing:

1. the property is pointed at a fact — *Auto* only works if its **name** is
   recognisable, so a property called `Property 1` needs **Use: …**;
2. an offer is loaded — press **Load Offers**, since the counts come from real
   products.

A property set to *Leave alone* or pinned to *Always "X"* has no groups by
definition, and says so.

Two deliberate behaviours: if the price needs more digits than any variant
offers, it takes the **widest** one rather than clipping; and if a variant
combination doesn't exist in the set, the card keeps the variant it had and
the log says how many times that happened.

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

## The review grid — works like a sheet

The panel widens on this tab. Columns mirror the client's own review sheet:
`#` · Product · **SALE** · MRP · Weight · Badge · **P1·P2** (read-only).

It behaves the way Sheets does, because it replaces one:

- **Click a cell and type** — typing replaces; **Enter** commits and moves
  down, **Tab** moves right, **Esc** cancels, arrows move, shift+arrows extend.
- **⌘C / ⌘V move real ranges**, in the same TSV dialect Google Sheets uses —
  copy cells here and paste into Sheets, or copy a block from Sheets and paste
  it onto a cell here. Pasting past the last row **adds rows**; pasting one
  copied cell into a selected range fills the range.
- **⌘Z / ⇧⌘Z** undo and redo everything — edits, pastes, deletes, bulk tools.
- **⌘D** fills the first selected row down through the selection.
- Click a **row number** to select the row (shift-click for several), a
  **column name** for the column, the `#` corner for everything.
- Prices go through the same parser as the splitter: type or paste `₹350`,
  `1,250`, `11,50` and get 350, 1250, 11.50, displayed as the flyer prints
  them. The P1·P2 column live-mirrors what `#price1`/`#price2` will receive.

Bulk tools act on the **selected rows**, or on every row when nothing is
selected. Delete removes selected rows — ⌘Z brings them back.

**Right-click anywhere in the grid** for structure edits, the Sheets way:
insert row(s) above / below (select 3 rows → it inserts 3), delete rows,
insert a column left or right of the clicked one, remove a custom column.
**+ Row** inserts below the selection when there is one, and appends when
there isn't. Every structural change is one ⌘Z away from undone.

### Custom columns — extra design text like a second badge

**+ Col** adds a column for text the *design* carries but Cirqle has no field
for: a second badge, a Malayalam tagline, a shelf code. The name becomes the
layer it fills — **Badge 2 → `#badge2`** — so add a text layer with that name
to the card template and every card gets its row's value at build time.
Right-click a column header (or any cell) to insert it **at that position**
rather than at the end — the column sits where you put it, between built-in
columns included.

Custom columns behave like every other column (edit, copy/paste, ⌘Z, fill
down) and are remembered per workspace. Removing one keeps the values on the
rows — add the same name back and they reappear. Built-in names are refused
("Badge" is already a column; "Offer Text" is Cirqle's own field), and four is
the ceiling so the grid stays readable.

Two honest limits, both deliberate: the values are **not saved to Cirqle** —
Cirqle's schema stays untouched — so they live for this plugin session, carried
across the Save → Build hop by row position; and they apply only to the
campaign saved from this table, never to one loaded later.

| Tool | What it does |
|---|---|
| **AA / Aa / Aa Bc** | UPPERCASE · First letter capital · Title Case. Names use rules byte-identical to `src/lib/format-product-name.ts`; the weight is cased too, so `100gm` prints as `100 Gm` instead of raw. |
| **Trim** | Collapse repeated spaces. |
| **⇄ SALE/MRP** | Swap the two columns when a client sends them the other way round. |
| **+ Weight → name** | `Cashew 240` + `100gm` → `Cashew 240 100 gm`. Idempotent. Press **Aa Bc** *after* this to get `Cashew 240 100 Gm` — the order matters, since casing first leaves the appended unit lowercase. |
| **+ Row / Delete** | Add a blank row (lands selected, ready to type); delete the selected rows. |
| Column dropdowns | Re-map which split column is Product / Price / MRP / Weight / Badge / Ignore. Re-mapping re-derives the rows, so it discards manual cell edits — map first, edit after. |

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
