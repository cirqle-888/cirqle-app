-- ═══════════════════════════════════════════════════════════════════════════
-- FREEZE THE WORK-VALUE STAMP ON FINALIZED PAYROLL
--
-- tasks.work_value* is not decoration — it is the BASIS contributor earnings
-- were computed from. Earnings are already frozen once a month's payroll is
-- finalized (recalcTaskCommissions bails on isTaskMonthProtected), but the
-- stamp was not: changing an agreement's Work Value re-stamped every covered
-- task regardless of month.
--
-- The result was a record that misreported itself. A July task would display
-- "AED 25" while its contributor had actually been paid from AED 20, with
-- nothing on screen revealing the discrepancy — the audit trail contradicted
-- the payslip.
--
-- Rule now: a task in a finalized payroll period is immutable in BOTH
-- respects. The amount paid and the basis it was computed from freeze
-- together, so a historical task always shows the figure it was actually paid
-- from.
--
-- TWO write paths had to be closed, not one:
--   1. restamp_agreement_item_work_values() — bulk re-stamp when an agreement
--      item's Work Value changes.
--   2. set_task_work_value() — the per-row BEFORE trigger, which recomputes
--      the stamp whenever quantity / coverage / date changes. Fixing only (1)
--      would have left the same inconsistency reachable by editing a task's
--      quantity in a closed month.
--
-- The finalization predicate mirrors isMonthFinalized() in
-- src/lib/payroll/compute.ts exactly — same two signals, same fail-closed
-- posture, same "a missing period_locks table is not a lock" rule — so the SQL
-- and TS guards can never disagree about which months are closed.
--
-- Deliberately NOT changed: invoices, client billing, retainer fees, coverage
-- detection. This migration only governs when the internal work-value stamp
-- may move.
--
-- Rollback:
-- supabase/rollbacks/20260807150000_freeze_work_value_on_finalized_payroll_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The shared predicate ──────────────────────────────────────────────────
--    Mirror of isMonthFinalized(). Fails CLOSED (returns TRUE) on an
--    unreadable month, because wrongly skipping a re-stamp leaves a value
--    merely stale, while wrongly rewriting a paid month corrupts the record
--    behind an issued payslip.
CREATE OR REPLACE FUNCTION public.is_month_payroll_finalized(p_month INT, p_year INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_hit BOOLEAN;
BEGIN
  -- No readable month → treat as closed.
  IF p_month IS NULL OR p_year IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Signal 1: a payslip for this month reached a finalized status (money moved).
  SELECT EXISTS (
    SELECT 1 FROM public.payroll
     WHERE month = p_month AND year = p_year AND status = 'paid'
  ) INTO v_hit;
  IF v_hit THEN RETURN TRUE; END IF;

  -- Signal 2: the owner explicitly closed the books for this month.
  -- A MISSING TABLE IS NOT A LOCK — pre-migration environments must behave
  -- exactly as before, so absence of period_locks means "feature not
  -- installed", never "locked". Dynamic SQL so this function still compiles
  -- and runs where the table does not exist.
  IF to_regclass('public.period_locks') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.period_locks WHERE month = $1 AND year = $2)'
      INTO v_hit USING p_month, p_year;
    IF v_hit THEN RETURN TRUE; END IF;
  END IF;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_month_payroll_finalized(INT, INT) IS
  'TRUE when a month''s books are closed (any paid payslip, or an explicit period_locks row). SQL mirror of isMonthFinalized() in src/lib/payroll/compute.ts. Fails closed.';

CREATE OR REPLACE FUNCTION public.is_task_date_payroll_finalized(p_date DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  -- A NULL date yields NULL month/year, which the callee treats as closed.
  SELECT public.is_month_payroll_finalized(
           EXTRACT(MONTH FROM p_date)::INT,
           EXTRACT(YEAR  FROM p_date)::INT)
$$;

COMMENT ON FUNCTION public.is_task_date_payroll_finalized(DATE) IS
  'TRUE when a task dated p_date falls in a finalized payroll period. Mirror of isTaskMonthProtected().';

-- ── 2. Bulk re-stamp skips finalized periods ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.restamp_agreement_item_work_values(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.tasks t
     SET work_value_inr = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1) * rate_to_inr_for(i.currency), 2)
         END,
         work_value = CASE
           WHEN i.work_unit_value IS NULL THEN NULL
           ELSE ROUND(i.work_unit_value * COALESCE(t.quantity, 1), 2)
         END,
         work_value_currency = CASE
           WHEN i.work_unit_value IS NULL THEN NULL ELSE i.currency
         END
    FROM public.client_agreement_items i
   WHERE i.id = p_item_id
     AND t.retainer_item_id = p_item_id
     AND NOT COALESCE(t.bill_as_extra, FALSE)
     AND t.deleted_at IS NULL
     -- Payroll already paid out against this task's stamp: leave it exactly as
     -- it was, so the record keeps matching the payslip.
     AND NOT public.is_task_date_payroll_finalized(t.task_date);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.restamp_agreement_item_work_values(UUID) IS
  'Re-stamp work values for an agreement item''s covered tasks in OPEN payroll periods only. Returns rows updated; finalized periods are excluded and counted nowhere.';

-- ── 3. The per-row trigger preserves a finalized task's stamp ────────────────
--     Without this, editing quantity on a task in a closed month would move
--     its stamp while its earnings stayed put — the same inconsistency by a
--     different route. INSERTs are unaffected: a brand-new row has no prior
--     stamp to protect, and nothing has been paid against it.
CREATE OR REPLACE FUNCTION public.set_task_work_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit NUMERIC(12,2);
  v_cur  TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND public.is_task_date_payroll_finalized(NEW.task_date) THEN
    NEW.work_value          := OLD.work_value;
    NEW.work_value_currency := OLD.work_value_currency;
    NEW.work_value_inr      := OLD.work_value_inr;
    RETURN NEW;
  END IF;

  IF NEW.retainer_item_id IS NOT NULL AND NOT COALESCE(NEW.bill_as_extra, FALSE) THEN
    SELECT work_unit_value, currency INTO v_unit, v_cur
      FROM public.client_agreement_items WHERE id = NEW.retainer_item_id;
    IF v_unit IS NULL THEN
      NEW.work_value_inr      := NULL;  -- no work value set on the agreement yet
      NEW.work_value          := NULL;
      NEW.work_value_currency := NULL;
    ELSE
      NEW.work_value          := ROUND(v_unit * COALESCE(NEW.quantity, 1), 2);
      NEW.work_value_currency := v_cur;
      NEW.work_value_inr      := ROUND(v_unit * COALESCE(NEW.quantity, 1) * rate_to_inr_for(v_cur), 2);
    END IF;
  ELSE
    NEW.work_value_inr      := NULL;
    NEW.work_value          := NULL;
    NEW.work_value_currency := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_work_value ON public.tasks;
CREATE TRIGGER trg_task_work_value
  BEFORE INSERT OR UPDATE OF client_id, service_id, task_date, quantity, bill_as_extra, retainer_item_id
  ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_task_work_value();

COMMIT;
