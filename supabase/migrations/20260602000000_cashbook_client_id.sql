-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Add client_id to cashbook_entries                                         ║
-- ║                                                                            ║
-- ║  Prerequisite for entity-aware (per-client, per-employee) FIFO allocation. ║
-- ║  cashbook_entries previously had no structured client link — the bulk      ║
-- ║  import stored client_name in description only. This migration adds the    ║
-- ║  column and backfills it from existing invoice_id linkages (entries the    ║
-- ║  import matched to an invoice already know the client via that invoice).   ║
-- ║                                                                            ║
-- ║  Entries without invoice_id need a re-upload with client_name_or_code     ║
-- ║  column, or manual tagging via the new client picker on the entry form.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

begin;

-- 1. Add the column (nullable — historical entries may not be tagged yet)
alter table cashbook_entries
  add column if not exists client_id uuid references clients(id) on delete set null;

-- 2. Backfill from the existing invoice_id link (covers entries the import matched)
update cashbook_entries ce
   set client_id = i.client_id
  from invoices i
 where ce.invoice_id = i.id
   and ce.client_id is null
   and i.client_id is not null;

-- 3. Index for fast per-client lookups (used by the FIFO allocation engine)
create index if not exists idx_cashbook_entries_client_id
  on cashbook_entries(client_id)
  where deleted_at is null;

-- 4. Also add issue_date to the dueInvoices query surface: already a column on
--    invoices, just adding an index so the FIFO engine's date filter is fast.
create index if not exists idx_invoices_client_issue_date
  on invoices(client_id, issue_date)
  where status not in ('cancelled', 'bad_debt');

commit;

-- AUDIT: after applying, check what's still untagged
-- select count(*) total, sum(case when client_id is null then 1 else 0 end) untagged
--   from cashbook_entries where deleted_at is null and type = 'inflow';
--
-- See untagged rows:
-- select id, entry_date, description, reference, amount_inr
--   from cashbook_entries
--  where client_id is null and deleted_at is null and type = 'inflow'
--  order by entry_date desc limit 50;
