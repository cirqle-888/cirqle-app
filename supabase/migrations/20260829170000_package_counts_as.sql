-- ═══════════════════════════════════════════════════════════════════════════
-- Spend a committed poster on something else
--
-- WHY
--   Elara's retainer includes 15 Social Media Posters a month. A Facebook cover
--   page is not a poster — it is its own service, with its own Pricing-Matrix
--   price — but the agreement with the client is that it comes OUT of the 15.
--
--   Coverage matches a task to an included line by service_id and nothing else
--   (lib/packages/progress.ts), so the cover could only be covered by pretending
--   it was a poster. That loses what the work actually was: every report, every
--   department figure and the service history would call it a poster forever.
--
-- WHAT THIS DOES
--   tasks.package_counts_as_service_id — "for package coverage only, treat this
--   task as this service". The task keeps its own service, its own price and its
--   own place in every report; it simply consumes one slot of the named line.
--
--   Per task, deliberately, and never automatic: the same cover is inside the
--   allowance for one client and billed on its own for the next, and only a
--   person knows which. Empty on every existing row, so nothing is reclassified.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS package_counts_as_service_id UUID REFERENCES public.services(id);

COMMENT ON COLUMN public.tasks.package_counts_as_service_id IS
  'Package coverage only: consume this service''s included allowance instead of the task''s own. Never changes the price or the reported service.';

-- Coverage is resolved per package, so the lookup is always narrowed by
-- package_id first; this keeps the substitution scan cheap on wide months.
CREATE INDEX IF NOT EXISTS idx_tasks_package_counts_as
  ON public.tasks (package_id, package_counts_as_service_id)
  WHERE package_counts_as_service_id IS NOT NULL;

COMMIT;
