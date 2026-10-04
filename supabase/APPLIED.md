# Applied migrations — production (`lgqarkdmlyfpacyqhfha`)

There is no `supabase_migrations` ledger on this project: the schema has always
been changed by hand in the SQL editor, and `supabase db push` has never been
used. This file is the manual substitute. **Append a row whenever you apply
something**, with the date and the verification you ran — otherwise the next
person has to re-derive the whole picture from the live catalogue, which is
exactly what the 2026-08-29 audit had to do.

Nothing here is a substitute for the real fix: the base schema (`clients`,
`employees`, `tasks`, `invoices`, …) has no DDL in this repository at all, so
`supabase start` cannot rebuild the database and there is no staging or
disaster-recovery path from migrations. That needs a baseline dump — see
`docs/` and the production-readiness report.

| Applied (UTC) | Migration | Result | Verified by |
|---|---|---|---|
| 2026-08-15 | `20260815100000_revoke_anon_and_secure_views` | applied | `scripts/sweep-anon.mjs` → 0 of 179 relations readable |
| 2026-08-16 | `20260816000000_company_branding_bucket` | applied | bucket `company-branding` present, public |
| 2026-08-18 | `20260818120000_employee_commission_agreements_grant` | applied | `has_table_privilege` → true |
| 2026-08-30 | `20260830100000_rls_close_remaining_tables` | applied | RLS-disabled tables 18 → **0**; 7 group-A policies created; 11 group-B tables RLS-on with no policy; all 18 still readable by the service role |
| 2026-08-30 | `20260801000001_employee_client_preferences` | applied | table present; anon 401; upsert→read→delete round-trip clean, 0 rows residue; FK rejects a bad `employee_id` (409) |
| 2026-08-30 | `20260815090000_company_settings_secret_rls` | applied | blanket policy gone; 4 scoped policies; RLS on; anon grants 0; `/api/invoice-logo` still 200 |
| 2026-08-30 | `20260815110000_authenticated_least_privilege` (Part A) | applied | `authenticated` grant rows 1055 → **302**, tables 161 → **44**; `permissions`, `designation_permissions`, `designations` all still granted (the lockout guard); `ad_accounts`/`deductions`/`company_settings` now false; `tasks`/`invoices` still true; anon still 0; production `/api/health` 200 and all 12 revoked tables still readable by the service role |
| 2026-09-04 | `20260904150000_cashbook_expense_markup` | applied | `cashbook_entries.markup_type` / `markup_value` readable via PostgREST (200, defaults `none` / `0`). Verified live in the Add Cash Book Entry form: tagging a client on an expense reveals the **Rebill cushion** section, and the entry saves with the chosen margin. `columnExists` now resolves true, so the section is offered rather than hidden. |
| 2026-09-04 | `20260904130000_cashbook_tasks_view_totals` | applied | Catalog rows present; grants verified per designation — Task Manager explicit `FALSE` on both keys, every other designation holding the matching `*_amounts` / `view_pricing` grant got `TRUE` (Accountant Assistant correctly got cashbook only, having never held `tasks.view_pricing`). Confirmed live in preview: CQID002's Cash Book shows no summary cards and no Accounts button while per-entry amounts remain; her Tasks list shows no per-day total while per-task Billing remains. |
| 2026-09-01 | `20260902100000_invoice_service_column` | applied | Both columns reachable via PostgREST (`invoices.show_service_column`, `clients.invoice_show_services`, both 200). Verified live: toggling **Service column** in an invoice preview adds/removes the column and the PDF reflows; **Always for {client}** persists the client default and clears the per-invoice override. |
| 2026-08-31 | `20260831120000_employee_presence` | applied | Table present; `anon` read → **401** (`permission denied`), signed-in `authenticated` read → **200**; heartbeat writes a row through `syncPresence`; a status written externally is reflected in the UI on the next sync, and derives correctly (`dnd` + note → "Do not disturb — 🎧 Focusing", cleared → "Available · Active now"). **Realtime does NOT deliver events for this table** — see the follow-up above; the feature polls and is unaffected. |
| 2026-08-30 | `20260830120000_employees_column_grants` (Part B) | applied | `employees` columns granted to `authenticated` **29 → 11**; the five sensitive ones (`base_salary`, `hourly_rate`, `bank_details`, `date_of_birth`, `invite_token`) now grant **NONE**; table-level `INSERT` and `DELETE` both **false**; `UPDATE` narrowed to `avatar_url, current_workspace_id`. Applied only after the code prerequisite (`9eb7490`) was live in `1b1d2dd`. Verified after: service role still reads sensitive columns (payroll/settings/import server code works), anon `select(*)` 401, `permissions` + `designation_permissions` still granted, production `/api/health` 200. |
| 2026-09-13 | `20260913060000_quote_plans` | applied | All five tables reachable via PostgREST (`quote_plans`, `quote_plan_lines`, `quote_plan_shares`, `quote_plan_ratings`, `quote_plan_costs`). Both permission keys present in the catalog (`quote_planner.view` 87, `quote_planner.manage` 88). Round-tripped a probe plan with a line, a share, a rating and a cost, then deleted the parent — **ON DELETE CASCADE verified**, 0 orphans in all four child tables, 0 rows residue. `anon` read of `quote_plans` → **401** (the table exposes what colleagues would be paid). |
| 2026-09-22 | `20260915100000_card_reconciliation` | applied | Card Statements (`/dashboard/cashbook/cards`) now renders its empty state — *No credit card accounts yet* — instead of the migration notice, so `card_statements` / `card_statement_lines` / `card_statement_matches` and the five `bank_accounts` card columns (`statement_day`, `due_day`, `credit_limit`, `card_last4`, `reconcile_from`) are all present. Both permission keys inserted (`card_reconciliation.view` 89, `.manage` 90). Not yet exercised end to end: no account of type `credit_card` exists to import a statement into. |
| 2026-09-22 | `20260922100000_bank_reconciliation` | applied | All three tables reachable and `bank_accounts.reconcile_from` present. Exercised end to end on a real Kotak statement: 184 lines imported for 25 Jan - 21 Sep 2026, opening 2,000 + movement 23,461.88 = closing 25,461.88, **difference 0.00**; auto-match gave 93 matched lines / 96 match rows (3 splits), 91 unmatched. Permission keys present (`bank_reconciliation.view` 91, `.manage` 92). Period left OPEN, not closed. |
| 2026-09-25 | `20260922140000_bank_line_kinds` | applied | `bank_statement_lines.line_kind` readable. Verified live on the same statement: **Suggest kinds** set aside 54 of the 91 unmatched in one action - Cashback & rewards 8 / 23.31, Interest earned 16 / 1,359.00, Fixed-deposit sweep 30 / **0.00** (confirming sweeps are internal, not income). Non-company total 1,382.31. Unmatched fell 91 -> 37, the residual the offline analysis predicted. |
| 2026-09-27 | `20260927100000_capture_permission` | applied | Run by hand in the SQL editor: "Success. No rows returned". Adds `capture.use` and backfills it to admins and designations holding `requests.view`, `advertising.view` or `offer.prepare`. Per-designation grant counts not yet checked. |
| 2026-10-03 | `20261003100000_draft_clients` | applied | Run by hand in the SQL editor: "Success. No rows returned". Adds the `clients.is_draft` / `draft_*` columns and `clients.create_draft` (admins only — grant per designation). |
| 2026-10-03 | `20261003120000_content_brief` | applied | Run by hand in the SQL editor: "Success. No rows returned". Adds `task_requests.content_brief` and `social_calendar_items.links`. |
| 2026-10-03 | `20261003220000_clients_edit_permission` | applied | Applied through the service connection (plain inserts, same statements as the file). `clients.edit` created; holders verified by query: Admin, Task Manager. No other designation held `settings.access`, so the backfill added nobody else. Also re-run by hand in the SQL editor the same night — idempotent, no change. |
| 2026-10-03 | `20261003200000_prune_inert_permissions` | applied | Run by hand in the SQL editor: "Success. No rows returned". Verified by query: the five inert switches (`tasks.export`, `billing.view_pricing`, `workspace.access`, `chat.client_conversations`, `recruitment.interview`) are gone with no grants left behind; `advertising.manage_providers` (Manage Ad Connections) exists and is held by Admin. Permission rows: 128 → 125. |
| 2026-10-04 | `20261003210000_remove_offer_manage_groups` | applied | Run by hand in the SQL editor: "Success. No rows returned". Verified by query: no `offer.manage_groups` row remains. |
| 2026-10-04 | `20261004100000_record_planner_and_designer` | applied | Run by hand in the SQL editor: "Success. No rows returned". Verified by query: `task_requests.created_by` and `social_calendar_items.created_by` present; `task_assignments` 3 → 22 (19 backfilled from request / calendar-item assignees). |

## Waiting to be applied

| Migration | What it adds | Until it is applied |
|---|---|---|
| `20261004120000_retire_offer_intake` | Relabels `offer.prepare` to "Manage offer product catalog" (all it still gates) and takes `capture.use` back from designations that only had it for AI Capture's retired offer mode — today, Flyer Designer. No data deleted. | Safe in any order. Until it runs, the Designations screen still describes `offer.prepare` as the old Offer Preparation workspace, and Flyer Designer still sees AI Capture (which now just points offer lists to Offer Studio). |
| `20260906120000_ownership_entries_basis` | Adds `'entries'` to the `ownership_programs.basis` CHECK — a per-participant COUNT basis that pays a rupee rate per hand-typed cash-book row. Also a partial index on `cashbook_entries (created_by, created_at)` and column comments recording that `ownership_awards.basis_amount_inr` holds a COUNT on this basis, and `ownership_rules.fixed_amount_inr` a rate PER UNIT. | Everything else keeps working — the basis is inert until a program uses it. Choosing **₹ per cash-book entry** in Settings → Ownership and saving is rejected by the old CHECK; `friendly()` turns that into a run-the-migration sentence rather than a raw Postgres error. |
### Follow-up: Realtime is not delivering for `employee_presence`

The migration runs `ALTER PUBLICATION supabase_realtime ADD TABLE
public.employee_presence` and the browser's channel reports `SUBSCRIBED`, but no
INSERT, UPDATE or DELETE event ever arrives (verified 2026-08-31 by writing rows
with the service role while a subscribed tab watched). The feature does not
depend on it — the roster is polled once a minute through `syncPresence`, so
dots are correct within the minute either way — but statuses would land in under
a second if this were fixed. To diagnose:

```sql
select * from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'employee_presence';
```

No row means the publication add did not stick; re-run the `ALTER PUBLICATION`
on its own. If the row IS there, the next thing to try is
`alter table public.employee_presence replica identity full;` — Realtime needs
the full old record to evaluate RLS on updates and deletes.

## Rollbacks

Every migration above has a matching file in `supabase/rollbacks/`. Run the
`_down.sql` of the same timestamp. The RLS-close rollback REOPENS the exposure
it closed, so prefer editing a single policy over running it wholesale.
