-- Phase 9: Cashbook Payroll Allocations

-- 1. Create table
CREATE TABLE public.cashbook_payroll_allocations (
    id uuid NOT NULL DEFAULT extensions.gen_random_uuid(),
    cashbook_entry_id uuid NOT NULL,
    payroll_id uuid NOT NULL,
    allocated_amount numeric(15,2) NOT NULL DEFAULT 0.00,
    created_at timestamp with time zone NULL DEFAULT now(),
    updated_at timestamp with time zone NULL DEFAULT now(),
    deleted_at timestamp with time zone NULL,
    CONSTRAINT cashbook_payroll_allocations_pkey PRIMARY KEY (id),
    CONSTRAINT fk_cpa_cashbook_entry FOREIGN KEY (cashbook_entry_id) REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,
    CONSTRAINT fk_cpa_payroll FOREIGN KEY (payroll_id) REFERENCES public.payroll(id) ON DELETE CASCADE,
    CONSTRAINT cpa_positive_amount CHECK (allocated_amount > 0)
);

-- Indexes for performance
CREATE INDEX idx_cpa_cashbook_entry_id ON public.cashbook_payroll_allocations(cashbook_entry_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_cpa_payroll_id ON public.cashbook_payroll_allocations(payroll_id) WHERE deleted_at IS NULL;

-- 2. Trigger function to update payroll status
CREATE OR REPLACE FUNCTION sync_payroll_payments()
RETURNS TRIGGER AS $$
DECLARE
    affected_payroll_id uuid;
    total_allocated numeric;
    p_net numeric;
BEGIN
    -- Determine which payroll to check
    IF TG_OP = 'DELETE' THEN
        affected_payroll_id := OLD.payroll_id;
    ELSE
        affected_payroll_id := NEW.payroll_id;
    END IF;

    -- Calculate total allocated amount for this payroll
    SELECT COALESCE(SUM(allocated_amount), 0) INTO total_allocated
    FROM cashbook_payroll_allocations
    WHERE payroll_id = affected_payroll_id AND deleted_at IS NULL;

    -- Get the net_salary for this payroll
    SELECT net_salary INTO p_net
    FROM payroll
    WHERE id = affected_payroll_id;

    -- If total_allocated >= net_salary, mark as paid. Else pending.
    -- Assuming a small tolerance for floating point matching.
    IF total_allocated >= (p_net - 0.01) THEN
        UPDATE payroll
        SET status = 'paid',
            paid_date = COALESCE(paid_date, CURRENT_DATE)
        WHERE id = affected_payroll_id AND status != 'paid';
    ELSE
        UPDATE payroll
        SET status = 'pending',
            paid_date = NULL
        WHERE id = affected_payroll_id AND status != 'pending';
    END IF;

    RETURN NULL; -- AFTER trigger
END;
$$ LANGUAGE plpgsql;

-- 3. Create the triggers
CREATE TRIGGER trigger_sync_payroll_insert
AFTER INSERT ON cashbook_payroll_allocations
FOR EACH ROW
EXECUTE FUNCTION sync_payroll_payments();

CREATE TRIGGER trigger_sync_payroll_update
AFTER UPDATE ON cashbook_payroll_allocations
FOR EACH ROW
WHEN (OLD.allocated_amount IS DISTINCT FROM NEW.allocated_amount OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION sync_payroll_payments();

CREATE TRIGGER trigger_sync_payroll_delete
AFTER DELETE ON cashbook_payroll_allocations
FOR EACH ROW
EXECUTE FUNCTION sync_payroll_payments();
