# Page speed, 15 November 2026: the page that reloaded itself every minute

Follows `2026-11-09-round-trips.md`. Same method: live database, dev server,
admin account, laptop in Kerala; timings are a full RSC fetch of the route
(`fetch(route, { headers: { RSC: '1' } })`, read to the end) on a warm compiler.

## What was actually slow

### 1. Every open tab re-rendered its whole page once a minute

Not a query. The proxy keeps a signed 60-second profile cookie
(`cirqle.mw.profile`) and renews it on whichever request first finds it
expired. When that request is a **Server Action**, Next copies the proxy's
cookie into the action's own cookie jar — and cannot tell that apart from the
action calling `cookies().set()`. It marks the path revalidated, renders the
entire page into the action's response, and tells the browser to drop its
router cache.

- `next/dist/server/async-storage/request-store.js` → `mergeMiddlewareCookies`
- `next/dist/server/web/spec-extension/adapters/request-cookies.js` →
  `workStore.pathWasRevalidated = ActionDidRevalidateStaticAndDynamic`

The presence heartbeat is a Server Action that fires every 60 seconds; the
cookie lives 60 seconds. So the cookie was always expired when the heartbeat
arrived. Measured on the dashboard, heartbeat response by heartbeat:

| | Response | Time |
|---|---|---|
| Cookie still fresh | 1.3 KB | 0.6 s |
| Cookie expired (every minute) | **720 KB** | **5.2 s** |

Per tab, per minute, on whatever page was open: 2.7 MB on Contributions and
Payroll, 1.2 MB on Tasks. The dev log shows it as the same `fetchAll … 5683
rows` warning repeating every ~61 seconds for as long as a tab sat open. It
also meant:

- the first thing a person clicked after a minute's pause (tick a task, save
  a field) paid for a full page render on top of its own work;
- `staleTimes` in `next.config.ts` (30 s / 5 min) was being wiped every
  minute, so "instant when you go back to a page" rarely happened.

### 2. Sequential pages of one table

`fetchAll` pages past PostgREST's 1,000-row cap one request after another.
`contribution_scores` is 5,683 rows — six round trips in a row wherever it is
read. On the dashboard that read sat inside the batch the shell waits on.

### 3. Reads waiting on reads they did not need

- Dashboard department panel: three waves (batch → invoice lines by invoice id
  → scores by ~2,000 task ids), and it could not start until the main batch
  had finished, because it was handed the cash-book rows rather than a promise.
- Social Calendar: thirteen awaits in a row for 83 KB of data.
- Payroll: one await per prior-period adjustment, in a loop, then bank
  accounts after everything else.
- Clients / Client ranking: departments and follow-ups after the batch.
- `loadCurrentUser`: employee, then permissions — two round trips before
  almost every page could begin, on any page opened more than 30 s after the
  last.

## What changed

| Change | Where |
|---|---|
| A Server Action is never answered with the profile cookie. It reads the profile from the cookie, then this instance's memory (same payload, same 60 s expiry, same auth-id binding), then the database | `lib/supabase/middleware.ts` |
| `fetchAll`: first page as before; if it is full, later pages are requested together (2, then 4, then 8) by copying the builder. Only for ordered queries on a real builder — otherwise sequential, as before | `lib/supabase/server.ts` (`cloneQuery`) |
| Dashboard: cash book, invoices, follow-ups and pending pay are their own promises; the department panel starts beside the batch, not after it | `dashboard/page.tsx` |
| Dashboard "unscored" check reads scores of tasks in its 90-day window (was every score of 36 months) | `dashboard/page.tsx` |
| Department panel: one wave. Invoice lines are read whole; scores are selected by task date with a join instead of by id list | `lib/dashboard/department-facts.ts` |
| Social Calendar: everything that depends only on the viewer starts at once; items, packages and delivered work leave together once the plan is known; two repeat reads of `services` answered from one | `social-calendar/page.tsx` |
| Payroll: adjustment lineage read together; bank accounts in the batch | `payroll/page.tsx` |
| Clients, Client ranking, Quote Planner: large tables paged together and ordered by id; trailing reads moved into the batch | the three `page.tsx` files |
| Permission read starts beside the employee read, using the expired cache entry only as a guess at the designation — both reads are fresh, and the early one is discarded unless the fresh employee row confirms it | `lib/permissions/check.ts` |

`cloneQuery` reaches into supabase-js (it relies on a builder holding its
request in a `URL` and a `Headers`). It fails closed to sequential paging if
that shape changes, and `lib/supabase/fetch-all.test.ts` runs it against the
real library — row for row, with later pages answering first — so an upgrade
that breaks the copy fails CI rather than dropping rows.

A page whose connection drops mid-response is now asked for once more
(`askPage`). supabase-js retries a fetch that fails to start but not one cut
off while the body is read — undici's `TypeError: terminated` — and the
30-second keep-alive from 9 November leaves more old sockets to lose that race
on. It happened five times in this 6½-hour dev log; each time a page read a
table as shorter than it is, or empty, with nothing on screen to say so. This
covers `fetchAll`, `fetchAllIn` and `fetchAllParallel`; a plain
`await supabase.from(…)` is still exposed.

Three of the reads that were converted had **no `.order()` at all** while
paging across three pages (`tasks` on Clients, Client ranking and Quote
Planner). An unordered paged read can repeat or skip a row at a page boundary
without any error. They are ordered by id now.

## Before → after (local dev, warm)

Four full loads of each route, old code then new code, back to back on a quiet
machine. Milliseconds, in the order taken.

| | Before | After |
|---|---|---|
| Idle tab, per minute | full page re-render (0.7–2.7 MB) | 1.3 KB heartbeat |
| Dashboard | 5,793 · 5,340 · 2,899 · 2,616 | 1,038 · 1,159 · 1,014 · 920 |
| Social Calendar | 1,762 · 1,955 · 1,655 · 1,966 | 375 · 361 · 310 · 418 |
| Quote Planner | 1,444 · 3,533 · 1,240 · 1,178 | 403 · 462 · 774 · 476 |
| Clients | 946 · 977 · 783 · 1,362 | 457 · 456 · 418 · 510 |
| Client ranking | 539 · 586 · 855 · 730 | 274 · 382 · 266 · 551 |
| Payroll | 8,024 · 3,823 · 3,309 · 5,099 | 1,241 · 5,027 · 1,582 · 5,104 |

Payroll is two-humped on both sides: about 1.2–1.6 s now when it goes well
(3.3 s before), but roughly every other load still takes 5 s. That is the
2.7 MB payload (see below), not a round-trip problem, and it is not fixed.

Production will see smaller absolute numbers, as before — but the per-minute
re-render was costing real database egress and server time there too, per
open tab, all day.

### Same data, checked

Every change here was compared against the previous code on the same live
data, not just read for equivalence:

- Dashboard: the department panel's 1,462 day-facts sum to the same 2,059
  jobs, job value, billed, inflow and contribution pay to the paisa; the
  follow-up counts and the unscored-task list are the same.
- Quote Planner: SHA-256 over all 5,683 score rows and all 2,088 task rows,
  sorted, is identical old and new.
- Social Calendar, Payroll, Clients, Client ranking: the page's data payload
  is the same length to the byte.

## The trade accepted

None on freshness. The in-memory profile is consulted only by Server Actions
and expires exactly when the cookie would have. A Server Action arriving on a
cold instance with an expired cookie reads the profile from the database
(one or two small reads) instead of triggering a page render.

The hourly Supabase token refresh still sets cookies from the proxy; if that
lands on a Server Action the page re-renders once. That write is required.

## What is still on the table

- **Payload size.** Contributions 2.7 MB, Payroll 2.7 MB, Reports 1.5 MB,
  Tasks 1.2 MB, Cashbook 0.9 MB per load (uncompressed RSC). Payroll sends 24
  months of scores with each task embedded to a screen that navigates ±5
  months. This is now the largest remaining cost and it is a data-shape
  change per page, not a fetch change.
- **A dropped connection on a plain read.** The retry above only protects the
  paging helpers. The complete fix is a `fetch` wrapper on the admin client
  that retries a GET whose body fails; it touches every request the app makes,
  so it deserves its own change.
- **Unordered multi-page reads** elsewhere still page in sequence (`fetchAll`
  will not fan out without an order): `health/page.tsx` (cash book, tasks),
  `reports/reconcile` (invoice lines), `portal/[token]`. Adding
  `.order('id')` to each both speeds them up and makes their paging stable.
- **Local dev only:** the repository lives on an external USB SSD that is 93%
  full, and Turbopack's on-disk cache writes there. During this session the
  dev server logged cache writes of 17–48 s and cold route compiles of
  70–100 s, with every request queued behind them. Moving the checkout (or
  just `.next`) to the internal disk is likely the single biggest improvement
  to how the app feels on localhost. Production is unaffected.
- `x-pathname` is only set by the proxy when the session cookies are being
  rewritten, so the dashboard layout's `canOpenHref` guard almost always
  checks `/dashboard`. The proxy's own route table is what gates pages. Not a
  speed issue; noted because it was found here.
