-- ============================================================================
-- Scope the Designer designation's task visibility to their own services
-- ============================================================================
-- Additive, idempotent, INSERT-only. Safe to re-run.
--
-- THE BUG
-- 20260826100000 gave "Designer" tasks.view_own, on the reasonable-looking
-- assumption that it restricts what they see. It does not. Task breadth is
-- decided by resolveServiceScopeMode (src/lib/scope/service-scope.ts), which
-- only ever consults four keys:
--
--     scope.view_all, tasks.view_all      → 'all'
--     scope.by_service, tasks.view_by_service → 'services'
--     (none of the above)                 → 'legacy'
--
-- tasks.view_own is not among them, so Designer resolved to 'legacy' — and
-- filterTasksByVisibility returns the list UNFILTERED for any mode that is not
-- 'services'. The practical effect: a designer assigned Social Media and Print
-- work could see every task in the company, including Offer Flyer jobs for
-- clients they have nothing to do with. Reported from the Tasks page while
-- previewing CQID004, who has 22 services assigned and Offer Flyers explicitly
-- NOT among them.
--
-- THE FIX
-- Grant tasks.view_by_service, which is the key that actually engages the
-- filter. Their existing employee_services / employee_service_categories rows
-- then decide what they see — no new assignment work, the data is already
-- there.
--
-- NOTE ON THE EMPTY CASE: filterTasksByVisibility deliberately returns
-- everything to someone with ZERO assigned services, so a half-configured
-- rollout cannot lock anyone out. Every current Designer holder has services
-- assigned, so this grant restricts rather than no-ops — but a future Designer
-- with no services will see everything until they are assigned some. That is
-- the existing house behaviour, not something introduced here.
--
-- SCOPE: touches the Designer designation only. The stock "Employee"
-- designation has the identical problem (CQID003 holds it, 5 services
-- assigned, currently sees every task) and is deliberately NOT changed here —
-- narrowing it alters what an existing employee sees day to day and is the
-- owner's call, not a side effect of fixing Designer.
-- ============================================================================

BEGIN;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d
  JOIN public.permissions  p ON p.key = 'tasks.view_by_service'
 WHERE d.name = 'Designer'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

COMMIT;
