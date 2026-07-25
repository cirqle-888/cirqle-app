# Cirqle Studio — official Figma design companion for Cirqle

Replaces the pipeline

```
Cirqle → Google Sheet → Apps Script → Google Sheets Plugin → Figma
```

with

```
Cirqle → Secure API → Cirqle Studio Plugin → Figma
```

**without changing how designers design.** Figma remains the only design
environment. Cirqle never becomes a flyer builder — the plugin only automates
data loading and the repetitive duplication/fill work inside Figma.

## Folder structure

```
cirqle-studio/
├── README.md                 ← you are here
├── api/                      ← two read-only routes to copy into the Cirqle app
│   ├── offers/route.ts       →  src/app/api/figma/offers/route.ts
│   └── campaign/route.ts     →  src/app/api/figma/campaign/[id]/route.ts
├── plugin/                   ← the Figma plugin (import manifest.json)
│   ├── manifest.json
│   ├── ui.html               ← sidebar UI + all network calls
│   ├── src/
│   │   ├── code.ts           ← main-thread TypeScript (document work)
│   │   └── figma.d.ts        ← minimal typings (swap for @figma/plugin-typings)
│   ├── dist/code.js          ← prebuilt — no build step needed to install
│   ├── tsconfig.json
│   └── package.json          ← `npm run build` to recompile after edits
└── docs/
    ├── INSTALLATION.md
    ├── TESTING.md            ← the Sea Star 22-product test script
    ├── LIMITATIONS.md        ← honest Figma-API + schema limits
    └── ROADMAP.md
```

## Designer workflow (the success criterion)

```
Open Figma
  → Plugins → Development → Cirqle Studio
  → Select Client
  → Select Weekly Offer
  → Click Build Flyer
  → Flyer populated automatically
  → Designer performs visual review only
```

## How the pieces talk

- **ui.html** owns every network call (offers list, campaign download, product
  images). The Figma sandbox never touches the network.
- **code.ts** owns every document operation: template scanning, duplication,
  text fill, image fills, placeholder fills. It only ever ADDS a new frame to
  the CURRENT page — it never edits existing nodes or other pages.
- **API routes** are read-only and authenticate with the workspace's existing
  `offer_sheet_secret` (company_settings). No new credential to manage.

## Template compatibility

Layer matching uses the exact convention the Google Sheets Sync plugin uses
today — `#` + column name, lowercased, no spaces (`#product`, `#offerprice`,
`#mrp`, `#imageurl`, `#price1`, `#offerdatedisplay`) — **plus** forgiving
aliases (`#name`, `#price`, `#image`, `#photo`, `#badge`, `#oldprice`, …).
Matching is case-insensitive and whitespace-tolerant.

**Existing templates work without renaming a single layer.**

## Data parity guarantee

`/api/figma/campaign/[id]` returns rows produced by the same
`buildOfferSheetRows()` that fills the Google Sheet, so a flyer built by
Cirqle Studio is field-for-field identical to one built via the Sheet —
including split Price 1/Price 2 and both bindable date strings. During any
transition period the two pipelines cannot drift apart.

## What Phase 1 does NOT do (by design)

No AI generation. No Google Sheets. No Apps Script. No copy/paste. No writes
to Cirqle. No edits outside the current Figma page. See `docs/ROADMAP.md` for
what comes next and `docs/LIMITATIONS.md` for hard platform limits.
