# DB-00 — Production database security state

**Last probed:** 1 August 2026, after applying `20260801090000_apply_006_rls_idempotent.sql`
**Method:** live comparison of what the **public anon key** can read versus what the **service role** can read, against production. Read-only; no row data retrieved or stored. Reproduce with `node scripts/probe-rls.mjs` (exit 0 = nothing exposed).

> **Reading the probe correctly:** RLS denies rows by returning an **empty set, not an error**. A successful anon query proves nothing on its own — only the row counts do. `service > 0 and anon > 0` is exposure; `service > 0 and anon = 0` is a working policy.

---

## Current state — 26 tables protected, 10 still exposed

### Before (original probe)

Migration `001` had been applied — it enabled RLS on the core tables — but the wide-open `allow_all` policies from `supabase-schema.sql` were never dropped. RLS on + `allow_all` present = wide open. Migration `006`, which removes them, had never run. Every table with data was readable by the public key, including 5,265 earnings records, 79 payroll rows, and 4 employee records with salaries and bank details.

### After applying 006 (idempotent version)

Now hidden from the public key: `contribution_scores` (5,265), `contributions` (2,123), `tasks` (1,874), `invoice_items` (1,857), `client_service_pricing` (817), `activity_logs` (689), `cashbook_entries` (435), `client_product_catalog` (280), `invoices` (262), `designation_permissions` (214), `cron_runs` (158), `request_activity` (90), `payroll` (79), `notifications` (37), `invoice_followups` (26), `task_requests` (14), `payments` (13), `payslip_emails` (11), `designations` (8), `employees` (4), `ad_projects` (4), `intake_links` (3), `client_agreements` (1), `employee_commission_agreements` (1), plus `product_catalog` (381) and `offer_campaigns` (22) from the earlier offer-tables migration.

**All salary, earnings, payroll, billing and client-token data is now closed to the public key.**

The static file analysis in the original audit estimated ~69 unprotected tables. The live measurement is far better: several later migrations in `supabase/migrations/` did include RLS. **The real remaining gap is 10 tables**, not 54.

---

## Remaining exposure — DB-01 scope

Readable right now by anyone holding the public anon key:

| Table | Rows | Sensitivity |
|---|---|---|
| `company_settings` | 45 | **Critical — contains `offer_sheet_secret` and company bank details** |
| `provider_connections` | 1 | **Critical — plaintext Meta/Google OAuth access + refresh tokens** |
| `bank_accounts` | 3 | **High — company banking details** |
| `clients` | 62 | **High — client PII, plus every public hub/intake token** |
| `discount_logs` | 60 | Medium — commercial terms |
| `system_jobs` | 335 | Low–medium — job payloads may embed identifiers |
| `parameters` | 59 | Low |
| `services` | 41 | Low |
| `exchange_rates` | 6 | Low |
| `tools` | 4 | Low |

Also unprotected but currently empty, so they must be secured before they hold data: `quotations`, `audit_log`.

(`salary_advances`, `credit_ledger` and `performance_metrics` also answer anon queries, but they are covered by 006's policies and are simply empty — no action needed.)

---

## Actions still outstanding

1. **`DB-01` — secure the 12 tables above.** Scope is now small enough for one reviewed migration rather than a catalogue-wide sweep. Draft: `supabase/migrations/20260801100000_rls_remaining_tables.sql`.

2. **Rotate the exposed credentials.** These were readable with a public key for an unknown period and applying RLS does not un-disclose them:
   - `company_settings.offer_sheet_secret` — shared by the Google Apps Script sync, the Cirqle Studio Figma plugin, and `/api/figma/*`; rotating it breaks all three, so coordinate.
   - the Meta OAuth access and refresh tokens in `provider_connections` — revoke from the Meta app dashboard and reconnect.
   - any live `employees.invite_token` values — these bind a registration to an account (`src/app/(auth)/register/[token]/actions.ts:29-44`). Expire unused invites.
   - client hub/intake tokens in `clients` — regenerate if any client link is sensitive.

3. **Check Supabase API logs** for anonymous PostgREST reads against these tables to judge whether the exposure was ever used.

4. **Note what RLS does not fix.** Every SELECT policy from 006 is `USING (auth.uid() IS NOT NULL)`, so **any logged-in employee can still read all salary and billing columns**. That is 006's design. It is why the field-stripping in `src/lib/permissions/strip.ts` remains cosmetic against a determined user, and why per-designation read policies are Month 2 work.

5. **Watch for non-admin write failures.** 006 gates writes on `has_permission(auth.uid(), key)`, which grants everything to `is_admin = true` designations and otherwise checks `designation_permissions`. Because Contributions, Invoices and Cash Book write directly from the browser, a non-admin missing a key will now see failures there. The fix is granting the key in Settings → Designations, not reverting the migration.

---

## Applied migrations, confirmed live

- `migrations/001_designations_and_self_registration.sql`
- `supabase/migrations/20260718120000_offer_tables_rls.sql`
- `supabase/migrations/20260801090000_apply_006_rls_idempotent.sql` — applied 1 Aug 2026

`migrations/006_rls_enforce_auth.sql` in its original form is **not** re-runnable (45 `CREATE POLICY`, only 15 `DROP`). Use the idempotent version.
