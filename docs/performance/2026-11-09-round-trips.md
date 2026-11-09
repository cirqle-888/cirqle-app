# Page speed, 9 November 2026: round trips, not rows

Measured against the live database from a laptop in Kerala, dev server, admin
account, warm compiler. Numbers are from the dev server's own request log
(`application-code`) and the browser's Navigation Timing.

## What was actually slow

One tiny query to Supabase costs **~380 ms round trip from here** (Mumbai,
via Cloudflare). The tables are small — 2,112 tasks, 298 invoices, 5,658 score
rows — so data volume was never the problem. **The number of round trips a
page makes in sequence was.** Three things multiplied it:

1. **The middleware asked the Auth server who the user was on every request**
   (`auth.getUser()`), 230–1,217 ms before any page code ran. `loadCurrentUser`
   did the same again, *before* checking its own 30 s cache.
2. **Pages awaited independent reads one after another.** The dashboard ran
   seven reads in sequence after its main batch; the layout ran four
   (favourites → workspaces → members → current pointer) before any page
   could start; Tasks ran six, Invoices three, Cashbook one.
3. **Cold sockets.** Node drops an idle keep-alive connection after 4 s. A page
   here fans out to 20–30 reads, so every real page view began by opening
   ~25 TLS connections to Mumbai in parallel — about a second each. Measured:
   5 concurrent reads on cold sockets took **1,164 ms each**; one warm read
   took 291 ms; 30 concurrent reads on warm sockets finished in 283 ms total.
   The database was never queueing anything.

A fourth multiplier is production-only: **Vercel ran the app in Singapore
(`sin1`) while Supabase is in Mumbai (`BOM`)**, so every query in production
crossed the Bay of Bengal, and the users are in Kerala.

## What changed

| Change | Where |
|---|---|
| Verify the session JWT locally (`getClaims`) instead of calling the Auth server; the project signs with ES256 so the public key is fetched once | `lib/supabase/middleware.ts`, `lib/permissions/check.ts` |
| Layout loads favourites and workspace state together; workspace state loads its list and pointer together | `app/(dashboard)/layout.tsx`, `lib/workspaces/actions.ts` |
| Dashboard, Tasks, Invoices, Cashbook, Contributions: every read that depends only on the viewer joins the main batch | the five `page.tsx` files |
| `fetchAllParallel`: pages requested together via a fresh builder per page (fetchAll cannot: a shared builder's `.range()` is mutable) | `lib/supabase/server.ts`, used for scores/tasks/contributions and department facts |
| `fetchAllIn` lanes 4 → 8 | `lib/supabase/server.ts` |
| Keep HTTPS sockets to the database warm for 30 s | `src/instrumentation.ts` (new dependency: `undici`) |
| Three `visibility_*` settings rows from the shared 5-minute settings cache instead of three reads | Tasks and Contributions pages |
| FX rate auto-sync asks at most once an hour per browser | `app/(dashboard)/fx-rates-auto-sync.tsx` |
| Vercel region `sin1` → `bom1` | `vercel.json` — **takes effect on the next deploy** |

## Before → after (local dev, warm)

| | Before | After |
|---|---|---|
| Middleware (`proxy.ts`), every request | 230–1,217 ms | 5–14 ms |
| Dashboard — shell visible (TTFB) | 3.8 s | 0.49 s |
| Dashboard — fully rendered | 7.8 s | 3.0 s |
| Tasks | 2.2–3.2 s | 1.6–2.0 s |
| Contributions | 3.0–3.1 s | 2.2–2.3 s |
| Cashbook | 4.1 s | 1.7 s |
| Invoices | 1.9–2.5 s | 1.2–1.3 s |

Production will see smaller absolute numbers (in-region hops are ~5–50 ms,
not 380), but the same ratios — and the region move removes a hop of its own
from every query.

## The trade accepted

Local JWT verification means a user banned or deleted mid-session stays
recognised until their access token expires (one hour by default) rather than
instantly. This is the trade-off Supabase documents for middleware, and the
60 s profile cookie in the middleware had already accepted a smaller version
of it.

## What is still on the table

- **Dashboard streamed panels (~2.5 s after the shell).** The department panel
  reads 36 months of tasks plus scores for ~2,000 task ids on every load. The
  analytics panel beside it already caches closed months and reads only the
  current one live (`lib/analytics/cache`); department facts should do the
  same.
- **Fan-out width.** Contributions fires ~25 reads; six of them are
  rarely-changing config tables (`tools`, `tool_services`, `groups`,
  `group_services`, `parameters`, `parameter_services`). Caching them needs
  `revalidateTag` at every write site in Settings — not wired, so not done.
- **Tasks payload is 2.2 MB** (904 task rows with every column, plus the
  assignment graph). Not a round-trip problem; a different one.
- **Supabase PostgREST pool size** was *not* the limit (30 concurrent reads in
  283 ms), so there is nothing to change there.

## Measuring again

Dev server request log lines carry the split:
`GET /dashboard 200 in 2.9s (next.js: 15ms, proxy.ts: 5ms, application-code: 2.9s)`.
`application-code` on the dashboard includes the streamed panels; use the
browser's `performance.getEntriesByType('navigation')[0].responseStart` for
the shell. Contributions logs a per-read `[contrib query] <name>: <ms>` in
development. Run checks and browser timings **separately** — a concurrent
`tsc`/`vitest` run on the same machine inflated dashboard timings 2–3× and
produced the 12 s outlier seen during this work.
