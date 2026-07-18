-- ============================================================================
-- Atomic invoice paid_amount increment (fixes lost-update on concurrent payments)
--
-- Before: the client computed newPaid = paid_amount + delta from its local copy
-- and wrote it as an absolute value. Two payments recorded at once both read the
-- same base and the second overwrote the first — one payment silently vanished
-- from paid_amount (though both rows existed in `payments`).
--
-- This RPC increments in a single UPDATE, so concurrent calls serialise at the
-- row and both deltas count. Status is recomputed server-side from total_amount.
--
-- SECURITY DEFINER + pinned search_path (Supabase linter best practice). Only
-- callable by the service role in practice (server action), but safe either way.
-- ============================================================================

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
