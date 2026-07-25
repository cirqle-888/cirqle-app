# Installation

## Part 1 — API routes (once, ~10 minutes)

1. Copy the two route files into the Cirqle app:
   - `api/offers/route.ts`   → `src/app/api/figma/offers/route.ts`
   - `api/campaign/route.ts` → `src/app/api/figma/campaign/[id]/route.ts`
     (the folder is literally named `[id]` — Next.js dynamic segment)
2. Run the repo's own gates — both must stay green:
   ```bash
   npx tsc --noEmit -p .
   npm run build
   ```
   The routes follow the same patterns as `api/cron/archive-offers`
   (`createAdminClient` from `@/lib/supabase/server`, Bearer auth,
   fail-closed) and import only `@/lib/offer-sheet` beyond that.
3. Deploy as usual (Vercel).
4. Confirm the secret exists: Cirqle → **Apps → Offer Intake → Shared sync
   script → Shared secret**. If it's blank, save the settings once to generate
   it. This same secret is the plugin's Authentication Token.

No migration is needed — the routes only read tables that already exist.

## Part 2 — Plugin (per designer machine, ~2 minutes)

1. Copy the `plugin/` folder somewhere permanent.
2. Figma **desktop** app → Plugins → Development → **Import plugin from
   manifest…** → pick `plugin/manifest.json`.
3. It appears under Plugins → Development → **Cirqle Studio**.

`dist/code.js` is prebuilt and committed, so there is no npm install and no
build step on the design machine.

### Rebuilding after code changes (developers only)

```bash
cd plugin
npm install          # typescript + @figma/plugin-typings
npm run build        # tsc → dist/code.js
```

With `@figma/plugin-typings` installed you can delete `src/figma.d.ts` (the
offline stub) and add the official typings per that package's README.

## Part 3 — First connection

1. Open your flyer file in Figma, on the page that contains the product-card
   template (any component or frame with `#`-named layers).
2. Run Cirqle Studio.
3. Server URL: `https://app.cirqle.work` (or your deployment URL).
4. Authentication Token: paste the shared secret from Part 1 step 4.
5. **Connect** — the status chip flips to *Connected* and the Client dropdown
   fills. Settings are remembered per machine.

## Publishing to the whole team (optional)

Import-from-manifest is per machine. To distribute centrally, publish as a
**private organization plugin** from Figma's plugin publish flow (requires a
Figma Organization plan). Nothing in the code changes.
