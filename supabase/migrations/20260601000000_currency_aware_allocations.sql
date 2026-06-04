-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Currency-aware cashbook→invoice allocations                               ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║  cashbook_invoice_allocations.allocated_amount is always in ₹ (INR) — it   ║
-- ║  matches the cashbook entry's amount_inr (the over-allocation validator    ║
-- ║  already enforces SUM(allocated) ≤ entry.amount_inr).                      ║
-- ║                                                                            ║
-- ║  The OLD sync trigger set invoices.paid_amount = SUM(allocated_amount) and ║
-- ║  compared it to total_amount. After multi-currency, total_amount/paid_     ║
-- ║  amount are in the INVOICE currency, so for a SAR/QAR/AED invoice that     ║
-- ║  summed ₹ into a foreign-currency field and mis-computed status. It also   ║
-- ║  never maintained paid_amount_inr.                                         ║
-- ║                                                                            ║
-- ║  This migration makes the sync currency-aware:                            ║
-- ║    paid_amount_inr = SUM(allocated_amount)                  (₹ base)       ║
-- ║    paid_amount     = round(SUM(allocated_amount) / rate, 2) (invoice ccy)  ║
-- ║    status          derived from the invoice-currency balance              ║
-- ║  For INR invoices (rate = 1) the two columns are identical — no change.    ║
-- ║                                                                            ║
-- ║  Scope note: this maintains the ALLOCATION contribution to paid amounts.   ║
-- ║  The invoice "Record Payment" panel writes the `payments` table path       ║
-- ║  separately; do not record the same money through BOTH paths on one        ║
-- ║  invoice (pre-existing limitation — a full unification is a later task).   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

begin;

-- ── Per-invoice recompute from active allocations (currency-aware) ────────────
create or replace function recompute_invoice_from_allocations(p_invoice_id uuid)
returns void
security definer
language plpgsql
as $$
declare
    total_paid_inr numeric;   -- ₹ base (sum of allocated_amount)
    inv_total      numeric;   -- invoice currency
    inv_rate       numeric;   -- rate_to_inr stamped at invoice creation
    inv_status     text;
    inv_due        date;
    paid_ccy       numeric;   -- invoice currency
    new_status     text;
begin
    if p_invoice_id is null then return; end if;

    select coalesce(sum(allocated_amount), 0)
      into total_paid_inr
      from cashbook_invoice_allocations
     where invoice_id = p_invoice_id
       and deleted_at is null;

    select total_amount, coalesce(nullif(exchange_rate, 0), 1), status, due_date
      into inv_total, inv_rate, inv_status, inv_due
      from invoices
     where id = p_invoice_id;

    -- Convert the ₹ allocation total into the invoice currency.
    paid_ccy := round(total_paid_inr / inv_rate, 2);

    if paid_ccy >= inv_total and inv_total > 0 then
        new_status := 'paid';
    elsif paid_ccy > 0 then
        new_status := 'partial';
    elsif inv_due is not null and inv_due < current_date then
        new_status := 'overdue';
    else
        -- Preserve non-receivable states; otherwise an open invoice is 'sent'.
        if inv_status in ('draft', 'reviewed', 'cancelled', 'bad_debt') then
            new_status := inv_status;
        else
            new_status := 'sent';
        end if;
    end if;

    update invoices
       set paid_amount     = paid_ccy,        -- invoice currency
           paid_amount_inr = total_paid_inr,  -- ₹ base (keeps dashboards accurate)
           status          = new_status
     where id = p_invoice_id;
end;
$$;

-- ── Trigger wrapper: recompute the affected invoice(s) on any allocation change ──
create or replace function sync_allocations_to_invoices()
returns trigger
security definer
language plpgsql
as $$
begin
    if (tg_op = 'DELETE') then
        perform recompute_invoice_from_allocations(old.invoice_id);
    else
        perform recompute_invoice_from_allocations(new.invoice_id);
        -- If an allocation was re-pointed to a different invoice, fix the old one too.
        if (tg_op = 'UPDATE' and old.invoice_id is distinct from new.invoice_id) then
            perform recompute_invoice_from_allocations(old.invoice_id);
        end if;
    end if;
    return null;
end;
$$;

-- Re-bind the trigger (CREATE OR REPLACE keeps the old binding, but be explicit).
drop trigger if exists trigger_sync_allocations_to_invoices on cashbook_invoice_allocations;
create trigger trigger_sync_allocations_to_invoices
after insert or update or delete on cashbook_invoice_allocations
for each row
execute function sync_allocations_to_invoices();

commit;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  OPTIONAL one-time correction for EXISTING allocations                     ║
-- ║                                                                            ║
-- ║  Going forward the trigger keeps everything correct. To also fix invoices  ║
-- ║  whose paid amounts were synced by the OLD trigger (e.g. existing foreign- ║
-- ║  currency allocations), run the recompute below.                           ║
-- ║                                                                            ║
-- ║  ⚠ AUDIT FIRST. This resets paid_amount/paid_amount_inr of every invoice   ║
-- ║    that has active allocations to the allocation total. If any such invoice ║
-- ║    ALSO has a Record-Payment (`payments`) row or an imported paid amount,   ║
-- ║    that portion is NOT included here — check this query returns nothing     ║
-- ║    unexpected before running the recompute:                                ║
-- ║                                                                            ║
-- ║    select i.invoice_number, i.currency, i.paid_amount,                     ║
-- ║           (select count(*) from payments p where p.invoice_id = i.id) pays, ║
-- ║           (select count(*) from cashbook_invoice_allocations a             ║
-- ║              where a.invoice_id = i.id and a.deleted_at is null) allocs     ║
-- ║      from invoices i                                                        ║
-- ║     where exists (select 1 from cashbook_invoice_allocations a             ║
-- ║                    where a.invoice_id = i.id and a.deleted_at is null)      ║
-- ║       and exists (select 1 from payments p where p.invoice_id = i.id);      ║
-- ║    -- rows here = invoices paid through BOTH paths; reconcile them by hand. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- do $$
-- declare r record;
-- begin
--   for r in (select distinct invoice_id
--               from cashbook_invoice_allocations where deleted_at is null) loop
--     perform recompute_invoice_from_allocations(r.invoice_id);
--   end loop;
-- end $$;
