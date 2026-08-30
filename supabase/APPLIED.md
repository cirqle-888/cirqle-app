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
| 2026-08-30 | `20260830120000_employees_column_grants` (Part B) | applied | `employees` columns granted to `authenticated` **29 → 11**; the five sensitive ones (`base_salary`, `hourly_rate`, `bank_details`, `date_of_birth`, `invite_token`) now grant **NONE**; table-level `INSERT` and `DELETE` both **false**; `UPDATE` narrowed to `avatar_url, current_workspace_id`. Applied only after the code prerequisite (`9eb7490`) was live in `1b1d2dd`. Verified after: service role still reads sensitive columns (payroll/settings/import server code works), anon `select(*)` 401, `permissions` + `designation_permissions` still granted, production `/api/health` 200. |

## Rollbacks

Every migration above has a matching file in `supabase/rollbacks/`. Run the
`_down.sql` of the same timestamp. The RLS-close rollback REOPENS the exposure
it closed, so prefer editing a single policy over running it wholesale.
