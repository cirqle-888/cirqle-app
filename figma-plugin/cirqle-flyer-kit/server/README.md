# Companion endpoint for the Live tab

Two small read-only API routes for Cirqle. Deploy these and the plugin's
**Live** tab replaces the copy/paste step entirely: pick a client in Figma,
pull the live offer, or arm watch mode and let it rebuild on every change.

Copy the two files into the app:

```
src/app/api/figma/offers/route.ts            ← offers-route.ts
src/app/api/figma/offers/[token]/route.ts    ← offer-token-route.ts
```

## Before deploying — two things to check

These files were written **without the repo compiling next to them** (the
device was offline), so verify:

1. **The Supabase import.** Both files import the server client the offer
   actions already use. Open `src/app/intake/offer/[token]/actions.ts`, copy
   its Supabase client import + creation lines, and use those if they differ
   from what's in the route files.
2. **The `buildOfferSheetRows` call.** The `[token]` route builds its rows the
   same way the Sheet sync does. Open `src/lib/google-sheets/sync.ts`, find the
   `buildOfferSheetRows(...)` invocation, and mirror its arguments exactly.
   That guarantees the plugin receives byte-for-byte what the Sheet would have.

Then run the repo's own gate: `npx tsc --noEmit -p .` and `npm run build`.

## Design decisions (why it's shaped this way)

- **Auth = the existing `offer_sheet_secret`** from `company_settings` — the
  secret already provisioned for the Sheets sync. No new credential, no new
  rotation procedure; rotating the sheet secret rotates this too.
- **Read-only.** Neither route writes anything. The blast radius of a leaked
  secret is "someone can read active offer lists", not "someone can modify
  campaigns".
- **CORS `*` with an OPTIONS handler.** The plugin iframe has a `null` origin,
  so a wildcard is the only value that works. Safe here because the routes are
  bearer-token gated — CORS controls who can *read responses*, the token
  controls who gets a response worth reading.
- **Active campaigns only.** Finalised/archived offers are history, not design
  work. The designer dropdown should never show last month.
