-- Rollback for 20261022120000_invoice_paid_in_invoice_currency.
--
-- Puts back the book-rate conversion (paid = Σ ₹ ÷ invoice rate). Invoices
-- keep the paid amount and status the newer function gave them until one of
-- their allocations changes; to recompute them now, run the commented block at
-- the bottom. Foreign invoices paid in their own currency at a moved rate will
-- show a phantom balance again (INV-2609-062: 579.05 of 650 AED, "partial").

BEGIN;

DROP TRIGGER IF EXISTS trigger_refresh_allocations_on_entry_change ON public.cashbook_entries;
DROP FUNCTION IF EXISTS public.refresh_allocations_on_entry_change();
DROP TRIGGER IF EXISTS trigger_fill_allocation_invoice_ccy ON public.cashbook_invoice_allocations;
DROP FUNCTION IF EXISTS public.fill_allocation_invoice_ccy();

CREATE OR REPLACE FUNCTION public.recompute_invoice_from_allocations(p_invoice_id uuid)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    total_paid_inr numeric;
    inv_total      numeric;
    inv_rate       numeric;
    inv_status     text;
    inv_due        date;
    paid_ccy       numeric;
    new_status     text;
BEGIN
    IF p_invoice_id IS NULL THEN RETURN; END IF;
    SELECT coalesce(sum(allocated_amount), 0) INTO total_paid_inr
      FROM cashbook_invoice_allocations
     WHERE invoice_id = p_invoice_id AND deleted_at IS NULL;
    SELECT total_amount, coalesce(nullif(exchange_rate, 0), 1), status, due_date
      INTO inv_total, inv_rate, inv_status, inv_due
      FROM invoices WHERE id = p_invoice_id;
    paid_ccy := round(total_paid_inr / inv_rate, 2);
    IF paid_ccy >= inv_total AND inv_total > 0 THEN new_status := 'paid';
    ELSIF paid_ccy > 0 THEN new_status := 'partial';
    ELSIF inv_due IS NOT NULL AND inv_due < current_date THEN new_status := 'overdue';
    ELSIF inv_status IN ('draft', 'reviewed', 'cancelled', 'bad_debt') THEN new_status := inv_status;
    ELSE new_status := 'sent';
    END IF;
    UPDATE invoices SET paid_amount = paid_ccy, paid_amount_inr = total_paid_inr, status = new_status
     WHERE id = p_invoice_id;
END;
$$;

ALTER TABLE public.cashbook_invoice_allocations DROP COLUMN IF EXISTS allocated_amount_ccy;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Optional: recompute the invoices the forward migration corrected.
-- SELECT recompute_invoice_from_allocations(id) FROM invoices
--  WHERE invoice_number IN ('INV-2609-062', 'INV-2606-058');
