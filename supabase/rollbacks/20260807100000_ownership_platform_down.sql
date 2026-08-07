-- Rollback for 20260807100000_ownership_platform.sql
--
-- Purely additive migration (six tables + one defaulted column), so dropping
-- them restores the prior schema exactly. The contribution engine and Phase 1
-- financial core are untouched by both directions.
--
-- WARNING: this discards ownership award history and the organization
-- structure. Export ownership_awards first if any payslip already paid from
-- it — the payroll rows keep their ownership_earned totals, but the per-program
-- breakdown behind them lives only in ownership_awards.
--
-- Permission rows are left in place deliberately: dropping a permission key
-- cascades to designation_permissions and would silently rewrite role
-- configuration that an operator set by hand. They are inert without the
-- feature. To remove them too:
--   DELETE FROM permissions WHERE key IN ('payroll.manage_ownership','settings.manage_org');
BEGIN;

ALTER TABLE public.payroll DROP COLUMN IF EXISTS ownership_earned;

DROP TABLE IF EXISTS public.ownership_awards;
DROP TABLE IF EXISTS public.ownership_rules;
DROP TABLE IF EXISTS public.ownership_programs;
DROP TABLE IF EXISTS public.org_unit_scopes;
DROP TABLE IF EXISTS public.org_unit_members;
DROP TABLE IF EXISTS public.org_units;

COMMIT;
