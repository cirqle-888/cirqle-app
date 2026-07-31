-- Rollback for 20260728120000_retainer_allocation.sql
-- Drops the internal retainer-allocation columns. Purely additive migration,
-- so dropping them restores the prior schema exactly. (Drop the generated
-- column first, though CASCADE would handle the dependency either way.)
BEGIN;

ALTER TABLE public.client_agreement_items
  DROP COLUMN IF EXISTS allocated_unit_value,
  DROP COLUMN IF EXISTS included_quantity,
  DROP COLUMN IF EXISTS management_allocation_amount,
  DROP COLUMN IF EXISTS creative_allocation_amount;

COMMIT;
