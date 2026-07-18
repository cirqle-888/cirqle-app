-- ============================================================================
-- APPLY 1 — SAFE / ADDITIVE (run anytime, zero risk, no data loss)
-- Paste this whole file into the Supabase SQL editor and Run.
--   • Seeds the one permission key 006 needs but 005 doesn't create.
--   • Adds the atomic invoice-payment increment RPC (fixes lost-update bug).
-- ============================================================================

-- 1. payroll.mark_paid — referenced by 006's payroll_update policy but not
--    seeded by 005. Add it first so applying 006 later doesn't wrongly deny
--    "mark payroll paid" to non-admins. Admins already bypass.
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('payroll', 'mark_paid', 'payroll.mark_paid',
    'Mark Payroll Paid', 'Mark payroll records as paid without editing amounts', 53)
ON CONFLICT (key) DO NOTHING;

-- Grant it to admins (belt-and-suspenders; admins bypass anyway).
INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.is_admin = TRUE AND p.key = 'payroll.mark_paid'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- 2. Atomic invoice paid_amount increment (fixes concurrent-payment lost update).
CREATE OR REPLACE FUNCTION public.increment_invoice_paid(
  p_invoice_id uuid,
  p_delta      numeric,
  p_delta_inr  numeric
)
RETURNS TABLE (paid_amount numeric, paid_amount_inr numeric, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.invoices i
     SET paid_amount     = round((COALESCE(i.paid_amount, 0)     + p_delta)::numeric, 2),
         paid_amount_inr = round((COALESCE(i.paid_amount_inr, 0) + p_delta_inr)::numeric, 2),
         status = CASE
                    WHEN round((COALESCE(i.paid_amount, 0) + p_delta)::numeric, 2) >= COALESCE(i.total_amount, 0)
                      THEN 'paid'
                    WHEN round((COALESCE(i.paid_amount, 0) + p_delta)::numeric, 2) > 0
                      THEN 'partial'
                    ELSE i.status
                  END,
         updated_at = now()
   WHERE i.id = p_invoice_id
  RETURNING i.paid_amount, i.paid_amount_inr, i.status;
END;
$$;

-- Verify:
SELECT 'increment_invoice_paid' AS rpc,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'increment_invoice_paid')
            THEN 'created' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'payroll.mark_paid perm',
       CASE WHEN EXISTS (SELECT 1 FROM permissions WHERE key = 'payroll.mark_paid')
            THEN 'seeded' ELSE 'MISSING' END;
