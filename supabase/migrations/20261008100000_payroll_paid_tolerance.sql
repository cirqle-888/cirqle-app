-- Payroll: a payslip paid to within ₹1 is paid
--
-- sync_payroll_payments() marks a payslip paid when its cash-book allocations
-- reach net_salary − 0.01. Older nets were stored with paise (₹4,859.87) and
-- paid in rounded amounts (₹4,859.83), so about fourteen fully paid payslips
-- (Nov 2024 – Apr 2026) stayed "pending" over a few paise. A pending payslip
-- is rewritten by every recalculation of its month, so these paid months could
-- still change.
--
-- 1. The tolerance becomes ₹1 (rounding, never a real shortfall).
-- 2. Every pending payslip already covered to within ₹1 is marked paid, dated
--    the last cash-book payment allocated to it.
--
-- Partly paid payslips (short by more than ₹1) are left pending on purpose.
-- Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION sync_payroll_payments()
RETURNS TRIGGER AS $$
DECLARE
    affected_payroll_id uuid;
    total_allocated numeric;
    p_net numeric;
BEGIN
    IF TG_OP = 'DELETE' THEN
        affected_payroll_id := OLD.payroll_id;
    ELSE
        affected_payroll_id := NEW.payroll_id;
    END IF;

    SELECT COALESCE(SUM(allocated_amount), 0) INTO total_allocated
    FROM cashbook_payroll_allocations
    WHERE payroll_id = affected_payroll_id AND deleted_at IS NULL;

    SELECT net_salary INTO p_net
    FROM payroll
    WHERE id = affected_payroll_id;

    -- Within ₹1 counts as paid: nets carried paise, payments were rounded.
    IF total_allocated >= (p_net - 1) THEN
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

-- Re-sync the payslips the old tolerance left pending.
WITH covered AS (
  SELECT a.payroll_id,
         SUM(a.allocated_amount) AS paid,
         MAX(e.entry_date)       AS last_paid
  FROM cashbook_payroll_allocations a
  JOIN cashbook_entries e ON e.id = a.cashbook_entry_id AND e.deleted_at IS NULL
  WHERE a.deleted_at IS NULL
  GROUP BY a.payroll_id
)
UPDATE payroll p
SET status = 'paid',
    paid_date = COALESCE(p.paid_date, c.last_paid, CURRENT_DATE)
FROM covered c
WHERE c.payroll_id = p.id
  AND p.status = 'pending'
  AND c.paid >= p.net_salary - 1;

COMMIT;

-- Verify: pending payslips that are covered to within ₹1 — expect 0 rows.
--   SELECT p.id, p.net_salary, SUM(a.allocated_amount)
--   FROM payroll p JOIN cashbook_payroll_allocations a ON a.payroll_id = p.id AND a.deleted_at IS NULL
--   WHERE p.status = 'pending' GROUP BY p.id, p.net_salary HAVING SUM(a.allocated_amount) >= p.net_salary - 1;
