-- ═══════════════════════════════════════════════════════════════════════════
-- RETAINER ALLOCATION — internal split of a monthly retainer (Phase 1)
--
-- A retainer's monthly fee (already stored as client_agreement_items.unit_price)
-- can be split INTERNALLY across cost centres — e.g. Creative Production vs
-- Management — purely for operational metrics, profitability and utilisation.
-- These figures NEVER touch client invoicing: the client still pays the one
-- monthly retainer, full stop.
--
-- STRICTLY ADDITIVE: three nullable columns on client_agreement_items. Existing
-- agreements have NULLs (feature simply unconfigured) and every existing flow
-- behaves exactly as before. Backward-compatible.
--
-- Reuse (no duplication):
--   • unit_price          → the monthly retainer amount (fee per cycle)
--   • committed_quantity  → the included deliverable count (headline)
-- New here:
--   • creative_allocation_amount   — internal AED toward creative production
--   • management_allocation_amount — internal AED toward management/overhead
--   • included_quantity            — allocation denominator (operator-set;
--                                    defaults to committed_quantity in the UI)
--   • allocated_unit_value         — GENERATED, so it can never be hand-edited:
--                                    creative_allocation_amount / included_quantity
--
-- Rollback: supabase/rollbacks/20260728120000_retainer_allocation_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.client_agreement_items
  ADD COLUMN IF NOT EXISTS creative_allocation_amount   NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS management_allocation_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS included_quantity            NUMERIC(10,2);

-- Auto-computed internal unit value. STORED + GENERATED means the DB owns it —
-- any attempt to INSERT/UPDATE it directly errors, enforcing "never manually
-- edited". NULL when there is nothing to divide by (division-safe via NULLIF).
ALTER TABLE public.client_agreement_items
  ADD COLUMN IF NOT EXISTS allocated_unit_value NUMERIC(14,2)
    GENERATED ALWAYS AS (
      ROUND(creative_allocation_amount / NULLIF(included_quantity, 0), 2)
    ) STORED;

COMMENT ON COLUMN public.client_agreement_items.creative_allocation_amount IS
  'Internal AED of the monthly retainer attributed to creative production. NOT a client price — never invoiced.';
COMMENT ON COLUMN public.client_agreement_items.management_allocation_amount IS
  'Internal AED of the monthly retainer attributed to management/overhead. NOT a client price — never invoiced.';
COMMENT ON COLUMN public.client_agreement_items.included_quantity IS
  'Denominator for the allocated unit value (units the creative allocation is spread over).';
COMMENT ON COLUMN public.client_agreement_items.allocated_unit_value IS
  'Auto-computed internal/operational unit value = creative_allocation_amount / included_quantity. NEVER a billing price; never generate invoice lines from it.';

COMMIT;
