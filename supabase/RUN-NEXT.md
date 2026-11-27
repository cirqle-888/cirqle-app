# Database steps still to run (2026-11-21)

Everything the app's code already expects but that may not be in the live
databases yet. Each file is safe to run twice. Run them in the **Supabase SQL
editor**, one file at a time, pasting the **whole** file.

## 1. Cirqle app database (`lgqarkdmlyfpacyqhfha`)

### Step 1: see what is missing

Paste this and press Run. Every row that says `false` needs its file below.

```sql
select 'A  tasks.delete for CQID002' as item,
  exists (select 1 from public.designation_permissions dp
            join public.permissions p on p.id = dp.permission_id
            join public.employees e on e.designation_id = dp.designation_id
           where e.cqid = 'CQID002' and p.key = 'tasks.delete' and dp.allowed) as applied
union all
select 'B  offer intake retired',
  exists (select 1 from public.permissions where key = 'offer.prepare' and label = 'Manage offer product catalog')
union all
select 'C  client department',
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'clients' and column_name = 'department_id')
union all
select 'D  month draft reuses reviewed',
  coalesce((select pg_get_functiondef(p.oid) like '%''reviewed''%'
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'find_or_create_client_month_draft'
             limit 1), false)
union all
select 'E  client packages',
  to_regclass('public.client_packages') is not null;
```

### Step 2: run the file for each `false`

| Row | File in `supabase/migrations/` | What it does | Until it runs |
|---|---|---|---|
| A | `20261101120000_tasks_delete_for_cqid002_designation.sql` | Lets CQID002's role move tasks to Trash | That role has no Delete button |
| B | `20261004120000_retire_offer_intake.sql` | Renames `offer.prepare`, takes AI Capture back from Flyer Designer | Flyer Designer still sees AI Capture |
| C | `20261011120000_client_department.sql` | Optional department override on a client | The override stays hidden |
| D | `20261111120000_month_draft_reuses_reviewed.sql` | A month's draft invoice reuses a reviewed one instead of starting `-2` | Resync has to merge stray `-2` drafts |
| E | `20260813100000_package_coverage.sql`, then `20260814110000_client_packages.sql`, `20260814120000_package_invoice_suppression.sql`, `20260814130000_package_first_cycle.sql`, `20260826140000_packages_view_pricing.sql`, `20260829170000_package_counts_as.sql` | Client packages | Package screens show nothing |

"Success. No rows returned" means it worked. Then run Step 1 again: the row
should now say `true`. Add a line to `supabase/APPLIED.md` for each one.

Not in this list on purpose: `20261121120000_recommended_designations.sql` is
new work from another session today and is not committed yet. Run it once that
session says it is ready.

## 2. Website database (cirqle.work portfolio)

Stops the failing `work_collections` requests on every portfolio page and
turns on brand account pictures and covers. Both files only add columns, so
they are safe to run even if they were run before.

1. `Website New & Old/cirqle-website-v3/supabase/add-brand-avatar.sql`
2. `Website New & Old/cirqle-website-v3/supabase/add-brand-covers.sql`

## 3. Offer Studio database

Nothing to do. Migration 0007 (`clients.shown`) is in: the live app already
runs code from migrations 0015–0017, which came after it.

## 3. Privacy clean-up: staff names inside old WhatsApp requests (added 2026-11-27)

Not a schema change. Some requests the WhatsApp listener filed **before** the
staff-numbers list existed start with a line like
`From WhatsApp · group · sent by <WhatsApp display name>`, and where the sender
was one of our own people that display name is their real name. The app now
shows CQIDs only, but this text is stored data, so the code cannot remove it.
New requests are not affected: messages from staff numbers are no longer filed.

### Step 1: see which rows would change

Read the list before doing anything. It should contain our own people only —
a client contact who happens to share a first name must **not** be in it.

```sql
select r.ref_no,
       substring(r.description from 'sent by ([^\n]+)') as sender_in_text,
       e.cqid as would_become
  from public.task_requests r
  join public.employees e
    on lower(substring(r.description from 'sent by ([^\n]+)'))
       like '%' || lower(split_part(trim(e.name), ' ', 1)) || '%'
 where r.description like 'From WhatsApp%sent by %'
   and length(split_part(trim(e.name), ' ', 1)) >= 4
 order by r.ref_no;
```

### Step 2: only if every row above is one of ours

```sql
update public.task_requests r
   set description = regexp_replace(r.description, 'sent by [^\n]+', 'sent by ' || e.cqid)
  from public.employees e
 where r.description like 'From WhatsApp%sent by %'
   and length(split_part(trim(e.name), ' ', 1)) >= 4
   and lower(substring(r.description from 'sent by ([^\n]+)'))
       like '%' || lower(split_part(trim(e.name), ' ', 1)) || '%';
```

If Step 1 lists a client contact, do not run Step 2 as written — edit those
few requests by hand in the app instead (open the request, edit the brief).
