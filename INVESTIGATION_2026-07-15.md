# Local Dev Investigation — 2026-07-15

**Scope limit, stated upfront:** I could not run this app. My shell is Linux/aarch64; your `node_modules` are macOS arm64 Mach-O. The npm registry returns 403 from my sandbox and your Supabase host is unreachable. **Issues 3 and 4 are therefore not done — they need you.** Issues 1 and 2 are static analysis, which is sufficient for 1 and mostly sufficient for 2.

---

## 1. Root cause — browser unhandled Promise rejection

### What is proven

**The error string is not yours.** It lives in Next's own code:

```
node_modules/next/dist/esm/client/components/router-reducer/reducers/server-action-reducer.js:109
```

The exact throw condition (line 101–109):

```js
const contentType = res.headers.get('content-type');
const isRscResponse = !!(contentType && contentType.startsWith(RSC_CONTENT_TYPE_HEADER)); // text/x-component
if (!isRscResponse && !redirectLocation) {
  const message = res.status >= 400 && contentType === 'text/plain'
    ? await res.text()
    : 'An unexpected response was received from the server.';
```

So: **a Server Action's HTTP response was not `content-type: text/x-component` and carried no redirect header.** The fact that you get the *generic* message (rather than the server's own text) narrows it further — the response was **not** a `text/plain` 4xx.

**The uncaught call site is `src/components/comms/floating-comms-widget.tsx:117–123`:**

```js
useEffect(() => {
  const t  = setTimeout (() => { void refreshConvs(); void refreshNotifs() }, 0)
  const id = setInterval(() => { void refreshConvs(); void refreshNotifs() }, 120_000)
  return () => { clearTimeout(t); clearInterval(id) }
}, [refreshConvs, refreshNotifs])
```

`refreshConvs` awaits `listConversations()`; `refreshNotifs` awaits `getMyNotifications(20)`. Both are Server Actions. **`void` does not handle rejection** — it only silences the `no-floating-promises` lint rule. So when either action's promise rejects, nothing catches it → `unhandledRejection`, on a `setTimeout(…, 0)` at mount → *immediately after loading the dashboard*. Symptom matches exactly.

`<FloatingCommsWidget />` is mounted in `src/app/(dashboard)/layout.tsx:143`, so it runs on **every** dashboard page.

### What I ruled out (and why)

| Candidate | Verdict |
|---|---|
| **Middleware** | **No `middleware.ts` exists** anywhere in the project. |
| `FxRatesAutoSync` | Also fires on mount — but has `.catch(() => {})` at line 22. Cannot produce an unhandled rejection. |
| `CommandPalette` | Loads `listFrequent`/`listRecent` only inside `if (!open) return` — not on mount. |
| `DesktopNotifier`, `BirthdayCelebration` | No server-action imports. |
| Action code throwing | `requireChatUser()` returns `{ok:false, error}`; it doesn't throw or `redirect()`. `listConversations` returns `{ok:false}` on error. They degrade gracefully. |
| Missing env vars | All 13 keys present in `.env.local`, including `SUPABASE_SERVICE_ROLE_KEY`. |
| `getMyNotifications` living in `src/app/api/` | Unusual, but legal — correctly declares `'use server'`, and there's no colliding `route.ts`. Server Actions POST to the current page URL regardless. |

### What is NOT proven

**Why the response is non-RSC.** That is a runtime fact and I have no runtime. The mechanism is certain; the trigger is not.

Leading hypothesis: **a stale Server Action ID after a Turbopack HMR reload.** The client bundle holds an action ID the recompiled server no longer knows; Next answers with an HTML 404/error page instead of a flight response, producing exactly this error. This is dev-only and would not affect production. It's consistent with your own observation that all routes return HTTP 200.

**The decisive test — 60 seconds:**

1. DevTools → Network → filter **Fetch/XHR**
2. Hard-reload `/dashboard`
3. Find the POST carrying a `Next-Action:` request header
4. Read its **Status** and **Response `content-type`**

- `content-type: text/html` → confirms the stale-action-ID / error-page hypothesis. Restart `next dev`; if it stops, it's an HMR artifact, not an app bug.
- `content-type: text/x-component` → my hypothesis is wrong; the rejection is from something else and I'd want the response body.
- A 500 → check the dev server terminal for the matching server-side stack.

### Code changes — deliberately NOT made

You said *"Do not suppress the error. Fix the root cause."*

Adding `.catch()` to `floating-comms-widget.tsx` **is** suppression, and I won't apply it blind. There are two distinct defects:

1. **The action returns a bad response.** Root cause. Trigger unknown — needs the network trace above.
2. **The widget doesn't handle rejection.** A real robustness bug regardless of #1, and inconsistent with `FxRatesAutoSync` three lines away in the same layout.

Fix #1 first. Then #2 is worth doing on its own merits — but as *deliberate* error handling (surface a toast, or a silent `.catch()` matching the FX precedent), not as a way to hide #1.

---

## 2. `fetchAll` — 5205-row PERF WARNING

### Where it fires

`src/lib/supabase/server.ts:119`. **68 call sites** across the codebase; 8 on the dashboard alone.

### The mechanism, and why it costs what it costs

```js
const PAGE = 1000
for (let page = 0; page < 100; page++) {
  const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
  ...
  if (!data || data.length < PAGE) break
}
```

The pages are fetched **sequentially** — each `await` waits for the previous. 5205 rows = **6 blocking round-trips**, plus a 7th to discover the end. At ~50–150ms per Supabase round-trip that's roughly **0.4–1.0s of pure serial latency**, before any rendering, on every dashboard load. The rows are then held in memory and serialised to the client.

### The two unbounded callers

Six of the dashboard's eight `fetchAll` calls are date-bounded. **Two are not:**

**`src/app/(dashboard)/dashboard/page.tsx:84` — `invoices`**

```js
fetchAll(supabase.from('invoices')
  .select('id, invoice_number, total_amount, paid_amount, total_amount_inr, ...')
  .order('due_date', { ascending: true })
  .order('id', { ascending: true }))
```

No `.gte()`. Every invoice ever written, on every dashboard load, forever. **This is my prime suspect for the 5205.**

**`src/app/(dashboard)/dashboard/page.tsx:101` — `cashbook_entries`**

No date filter either — but here it's *deliberate*, per the comment: *"all-time for accurate bank balance calculation."* The running balance genuinely needs every row.

### Which one is it?

I can't tell without the database — **and neither can you, because the warning doesn't say.** That's the actual blocker, and it's fixable.

### Change applied (the only one)

`src/lib/supabase/server.ts:119–121`. `getQueryTable(query)` was already computed at line 89 and already in scope — the warning just never printed it:

```diff
- console.warn(`[PERF WARNING] fetchAll fetched ${allData.length} rows — consider adding date filters or cursor pagination.`)
+ console.warn(`[PERF WARNING] fetchAll fetched ${allData.length} rows from "${table ?? 'unknown'}" (${Math.ceil(allData.length / PAGE)} sequential round-trips) — consider adding date filters or cursor pagination.`)
```

Zero behaviour change — one log string. Verified with `tsc --noEmit` on the file: **exit 0, no errors**. Next dev run names the table.

### Recommendations (NOT applied — each changes behaviour)

**`invoices` → filter by status.** The dashboard widgets show overdue / due / to-be-invoiced. Paid-and-closed invoices from three years ago are fetched, serialised, shipped to the browser, and never rendered. `.neq('status', 'paid')` or a `.gte('issue_date', …)` window would likely cut this by most of its volume. **Verify against every consumer of `invoicesRes` first** — if any widget computes a lifetime total, a filter silently corrupts it. That's exactly the kind of change you told me not to make blind.

**`cashbook_entries` → keep the data, move the math.** Don't paginate this one; the balance needs all rows. The right fix is a Postgres RPC returning the aggregate (`select sum(...) from cashbook_entries where deleted_at is null`) plus a windowed fetch for the Cash Flow widget's visible range. Turns 6 round-trips + 5000 rows over the wire into one scalar. Bigger change, clearly correct, worth scheduling.

**Don't add cursor pagination** as the warning suggests. `fetchAll` already pages; cursors would swap `.range()` for keyset pagination — marginally faster, same row count, same payload. It treats the symptom. The volume is the problem.

---

## 3. Build verification — NOT DONE

`npm run build` is impossible from my sandbox: Turbopack and lightningcss are native macOS binaries, and I can't install Linux equivalents (npm 403).

**Partial substitute:** I started a full `tsc --noEmit -p tsconfig.json` using the pure-JS TypeScript compiler, which *does* run on my Linux node. **0 errors** at the point I stopped waiting — it was still running, slow over the mounted volume, so treat that as incomplete rather than a pass.

Worth knowing: **`next dev` with Turbopack does not typecheck.** Your "✅ No TypeScript compilation errors during development" doesn't actually assert that. `next build` does typecheck, which is one reason it may surface errors dev never showed you.

You run:

```bash
cd /Volumes/FQLab/Projects/cirqle-app
npx tsc --noEmit          # fast, isolates type errors from build errors
npm run build
```

---

## 4. Regression check — NOT DONE

Requires a running app and a live database. I have neither. Nothing I could say about Dashboard / Clients / Business Partners / Settings / Tasks / Invoices / Follow-ups / Reports / Sidebar would be anything but invention.

---

## 5. Additional issues found

- **`git worktree prune` silently did nothing.** `cirqle-app` still registers a worktree at `/Users/farooq/Projects/cirqle-app/.claude/worktrees/busy-lumiere-1c7fc9`. Prune only removes worktrees whose **directory is missing** — and `~/Projects` still exists, so it's a no-op. Either `git worktree remove --force '/Users/farooq/Projects/cirqle-app/.claude/worktrees/busy-lumiere-1c7fc9'`, or delete `~/Projects` and *then* prune. (I verified the branch is fully merged into main — 0 unique commits, nothing lost.)
- **npm audit:** 10 high in `desktop/`, 6 high + 2 moderate in `mobile/`, 9 high + 5 moderate + 1 low in `cirqle-portfolio-final-new`. Unrelated to these issues, but worth a look before production.
- **`cirqle-app` has 79 uncommitted files.** Commit or stash before deleting `~/Projects`.
- **`cirqle-portfolio-final-main` and `-main-backup` have broken git** (`bad object HEAD` → commit `d7943db` missing from their object stores). Pre-existing; identical in the originals.
- **The GitHub PAT `ghp_jZ0W...` is still live.** Remotes are repointed to SSH, but revoke it: https://github.com/settings/tokens

---

## 6. Production-ready?

**No — and I can't tell you either way.** Build and regression testing are exactly the evidence that question needs, and both are the two things I couldn't run.

What I can say:

- **Issue 1** — mechanism identified with confidence (`void` on line 120, uncaught). Trigger needs the 60-second network trace. If it's a stale action ID, it's a dev-only HMR artifact and not a production concern. **Get the trace before changing any code.**
- **Issue 2** — not a correctness bug. It's ~0.4–1.0s of serial latency on every admin dashboard load, growing linearly with your invoice/cashbook tables forever. Not a release blocker today; will become one.
