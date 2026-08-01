# Simplification Plan — Agreements & Contributions

**Goal, stated plainly:** Tasks is where work gets added. Agreements answers one question — *did we deliver what we committed?* Nothing else, for now.

**Effect:** roughly 2,700 of ~5,000 lines in the agreements module go away.

---

## The one rule that replaces four

Delivery is currently counted four different ways inside `src/lib/agreements/progress.ts` (367 lines):

1. **Calendar items** — `+1` per content type and variant (line 286)
2. **Tasks stamped `retainer_item_id`** — `+= task.quantity` (line 312)
3. **Explicitly linked tasks** — `+= task.quantity` (line 322)
4. **Safety net: same `service_id`** — `+= task.quantity` (line 328)

…plus a deliverable-type matcher, a dedupe set, and month proration.

Two problems. Rule 1 counts *items* while rules 2–4 count *quantity* — different units of measure inside one total. And rule 1 is fed by the broken PostgREST query in `server.ts:181-182`, so **it has been contributing zero in production all along and nobody noticed.** That is the strongest possible evidence it isn't needed.

**Replace all four with one:**

> Delivered = SUM(`quantity`) of tasks where `retainer_item_id` = this agreement line, status is completed, and `deleted_at` is null.

Why this rule: the coverage engine already stamps `retainer_item_id`, and that is the *same* mechanism that zeroes client billing. Using it for progress too means **progress and billing can never disagree**. One stamp, two consumers.

---

## Phase 1 — Make the number correct (2–3 days)

| # | Do | File |
|---|---|---|
| 1.1 | Backfill `retainer_item_id` on existing completed tasks that fall inside an agreement's service scope and date window. One-off script, dry-run first, print what it would stamp. | `scripts/backfill-coverage.mjs` |
| 1.2 | Rewrite progress to the single rule. Delete the calendar path, the explicit-link path, the service-id safety net, and the deliverable matcher. | `src/lib/agreements/progress.ts` → ~80 lines |
| 1.3 | Delete the broken calendar query rather than fixing it (supersedes task AGR-02). | `src/lib/agreements/server.ts:169-192` |
| 1.4 | Keep month proration — it is already correct and tested — but **show it**: `Committed 15/month · 8 this month (started 20 Jul)`. An unexplained "8" generates more questions than it answers. | `agreement-detail-client.tsx` |
| 1.5 | Update `progress.test.ts` for the single rule; add a case for a task with quantity > 1. | `src/lib/agreements/progress.test.ts` |

**Done when:** Elara's agreement shows `15 committed · N delivered · 15−N remaining`, and N matches a hand count of her completed Social Media Poster tasks this month.

---

## Phase 2 — Delete what nobody needs yet (1–2 days)

Delete outright:

```
src/lib/agreements/analytics.ts                      379   (and its effective-window bug — AGR-03 disappears with it)
src/lib/agreements/intelligence.ts                   171   health scores, risk bands
src/lib/agreements/forecast.ts                        95   forecast card
src/app/(dashboard)/dashboard/reports/retainer-analytics/  1077   whole surface
```

Also remove the duplicate renderings of the same information:

- the analytics block inside `agreement-detail-client.tsx` (~660 lines can go; target ~400)
- the "Retainer Insights" card on the client detail page — it duplicates the agreement page at ~70 queries per view
- the Social Calendar "Agreements Progress" meter

Keep untouched: `coverage.ts` (load-bearing — it stops double-billing), `types.ts`, `numbering.ts`, `events.ts`, `actions.ts`.

Also remove from the item editor the options that are stored but read by nothing: carry-forward rules, adjustments, `extra_unit_price`, `renewal_type`, `pending_approval` / `expired` statuses, quarterly/yearly cycles.

**What the Agreement detail page becomes — four things and nothing else:**

```
Elara Luxe Perfume · Active · from 20 Jul 2026 · AED 400/month

  Social Media Posters      15/month   ·  12 delivered  ·  3 remaining   [====------]
  Logo Design                1 one-time ·   1 delivered  ·  0 remaining   [==========]

  Covering tasks this month (12)         → list, each linking to the task
```

---

## Phase 3 — Pay employees for covered work (2–3 days)

The narrow version of the architecture doc. Nothing else from it is needed yet.

| # | Do |
|---|---|
| 3.1 | Add `service_work_values (service_id, unit_value, currency, valid_from, valid_to)`. Seed from current service default prices — day-one behaviour is unchanged. |
| 3.2 | Add to `tasks`: `work_unit_value`, `work_value_currency`, `work_value_base`, `work_value_fx_rate`, `work_value_source`. |
| 3.3 | Populate on task create/edit: task override → `service_work_values` at `task_date` → else `source='none'` and warn. **Never** fall back to client pricing — that reintroduces the billing coupling you are trying to remove. |
| 3.4 | Backfill existing tasks. Report how many land on `source='none'` before going further. |
| 3.5 | Point contributions at `work_unit_value × quantity` instead of `billing_amount`. Keep the old path behind a flag for one payroll cycle and diff the two outputs. |
| 3.6 | Contributions tab shows the work value and its source, so "why did this pay AED 20?" is answerable in the UI. |

**Done when:** Elara's covered poster bills the client AED 0 and pays contributions from AED 20, and last month's payroll totals are unchanged apart from covered tasks that previously paid zero.

---

## Deliberately not now

`allocated_unit_value` (delete it in Phase 2 — Phase 3 makes it redundant), revenue events, the seal mechanism, period locking, profitability reporting, legal entities, tax. All are in `docs/architecture/financial-core.md` when the business needs them. None are needed to answer "did we deliver 15 posts?"

---

## One decision still open

Task **#1883** (Logo Reveal Poster, Elara) is retainer-covered but carries AED 20 billing without `bill_as_extra`, so Elara is being charged AED 400 + AED 20. Choose:

- **Reset to 0** — it was inside the 15 included posts, or
- **Set `bill_as_extra = true`** — it was genuinely extra work

Either way, also fix the Edit Task save path, which let a manual edit write a billing amount onto a covered task without setting the flag. Otherwise this recurs on the next edit.
