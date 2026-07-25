# Cirqle Flyer Kit — Figma plugin

Builds offer-flyer product cards from a Cirqle offer table, and removes image
backgrounds on-device. No Google Sheet in the loop, no per-image API cost.

## Tab 0 — Live (maximum automation)

With the companion endpoint deployed (see `server/README.md`), the plugin
talks to Cirqle directly:

- **Pull & build** — pick a client from the dropdown, press once: products,
  prices, badges, images (optionally background-removed) land as finished
  cards. No copy, no paste, no Sheet.
- **Watch mode** — select your card template, arm it, walk away. The plugin
  checks Cirqle every 60 seconds; when that client's offer changes, the cards
  rebuild themselves and (if enabled) a 2× PNG of the finished frame exports
  automatically. The realistic weekly flow becomes: coordinator saves the
  offer in Cirqle → the open Figma file grows the finished cards on its own.
- The URL and API secret are remembered per machine (Figma clientStorage), so
  setup happens once.

The ceiling to know about: Figma has no headless mode — a plugin only runs
while Figma is open with the file loaded. Watch mode is the closest thing to
"no human in the loop" that Figma permits: the human opens the file in the
morning and everything after that is automatic.

## Install (2 minutes, no publishing needed)

1. Copy this folder somewhere permanent on the design machine.
2. Figma desktop app → menu **Plugins → Development → Import plugin from manifest…**
3. Pick `manifest.json` in this folder.
4. It now appears under **Plugins → Development → Cirqle Flyer Kit**.

Only the person who imports it sees it. To give it to the whole team, publish it
as a private **organisation** plugin from the same menu (needs a Figma Org plan),
or just repeat the import on each machine.

## Tab 1 — Flyer

The plugin fills layers by name, using the exact convention Cirqle already
documents (`#` + column name, lowercased, spaces removed):

| Column | Layer |
|---|---|
| Product | `#product` |
| Offer Price | `#offerprice` |
| MRP | `#mrp` |
| Badges | `#badges` |
| Image URL | `#imageurl` (an image layer, not text) |
| Price 1 / Price 2 | `#price1` / `#price2` |
| Offer Date Display | `#offerdatedisplay` |

Because it's the same convention the Google Sheets Sync plugin uses, **existing
templates work unchanged.**

**To use it:**

1. In Cirqle, open the offer → **Copy table**.
2. In Figma, select your product-card component.
   - Select **one** card → the plugin clones it once per product and lays them
     out in a grid.
   - Select **many** cards → it fills those cards in place, in order, and leaves
     your layout alone.
3. Paste the table into the plugin and press **Build cards**.

Options worth knowing:

- **Download product images** — pulls each row's Image URL into `#imageurl`.
- **Remove background from each product image** — cuts out every photo as it's
  placed. Slower (a second or two per image) but produces flyer-ready shots in
  one pass.
- **Hide layers with no value** — a product with no MRP hides its strikethrough
  instead of printing an empty one. This is on by default because an empty
  layer is worse than a missing one on a printed flyer.

Anything the plugin couldn't find a layer for is listed in the log, so a
template that's missing `#mrp` tells you immediately instead of printing blanks.

## Tab 2 — Remove BG

Select any layers with image fills and press the button. Works on product
shots, logos, or a photo inside a frame — not just flyer cards, so it's useful
for catalog and social work too.

It runs the same **u2netp** model Cirqle uses in the browser, so a photo cut
here matches one cut in the Cirqle catalog. Everything happens on the machine:
no upload, no subscription, no per-image fee.

First run downloads ~18 MB (model + WebAssembly runtime) and caches it for the
session. After that each image takes a couple of seconds.

## Tab 3 — Settings

- **Model** — the first time you use background removal, pick
  `public/models/u2netp.onnx` from disk. This always works and needs no deploy.
  Loading it from `https://app.cirqle.work/models/u2netp.onnx` instead requires
  a CORS header that the app doesn't currently send — see `cors-patch.md`. The
  plugin says so explicitly if you try.
- **Runtime** — onnxruntime-web pinned to 1.27.0, matching Cirqle's
  `package.json` so behaviour can't drift between the two.
- **Image layer** — change if your templates use something other than
  `#imageurl`.

## Notes and limits

- A Figma plugin cannot run headlessly. Someone has to open Figma and press the
  button — there's no way to generate a design with nobody in Figma. This
  removes every step *between* Cirqle and that click, not the click itself.
- `networkAccess` is `"*"` because product image URLs are arbitrary (client
  uploads, Supabase storage, image hosts) and can't be listed in advance.
  Narrow it in `manifest.json` if you standardise on one image host.
- Fonts must be available to Figma. If a template uses a font the machine
  doesn't have, Figma blocks the text edit and the plugin reports it.
- Nothing here writes back to Cirqle. It only reads a table you pasted.

## Optional next step

Right now the table is pasted by hand. Adding one token-gated endpoint to
Cirqle (`GET /api/figma/campaign/:token`, returning what `buildOfferSheetRows()`
already produces) would let the plugin show a client dropdown and pull the live
offer directly — removing the paste step and the Sheet entirely.
