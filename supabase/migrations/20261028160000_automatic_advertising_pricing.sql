-- Restore the historical Ad Running service as the explicit campaign default.
-- Existing client rates (including Mezza 30% and other clients 75%) win.
-- No historical tasks, projects or invoices are modified by this migration.
BEGIN;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS advertising_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS services_one_advertising_default
  ON public.services (advertising_default) WHERE advertising_default;
UPDATE public.services
SET advertising_default = true, is_active = true,
    default_price = COALESCE(default_price, 30)
WHERE id = '3a9b5a49-d55c-4688-b258-2746c48149d9'
  AND pricing_type = 'percentage_of_spend'
  AND NOT EXISTS (SELECT 1 FROM public.services WHERE advertising_default AND id <> '3a9b5a49-d55c-4688-b258-2746c48149d9');
COMMIT;
