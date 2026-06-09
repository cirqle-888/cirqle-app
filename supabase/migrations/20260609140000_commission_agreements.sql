-- ============================================================
-- Employee Commission Agreements
-- ============================================================
-- Lets specific employees earn a special, agreed commission on tasks for a
-- given Client + Service (with optional "all clients" / "all services"
-- wildcards), REPLACING their normal contribution-based earning — for that
-- employee on that task only.
--
-- STRICTLY ADDITIVE: with no agreement rows, the resolver is an identity
-- function and nothing changes. Existing employees/tasks are unaffected.
--
-- See COMMISSION_AGREEMENTS_DESIGN.md for the full architecture.
-- ============================================================

-- 1. Agreements table ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_commission_agreements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES public.clients(id)  ON DELETE CASCADE,  -- null = all clients
  service_id      uuid REFERENCES public.services(id) ON DELETE CASCADE,  -- null = all services
  agreement_type  text NOT NULL DEFAULT 'fixed_per_task'
                    CHECK (agreement_type IN ('fixed_per_task','percentage_of_billing','percentage_of_pool')),
  agreement_value numeric NOT NULL DEFAULT 0,     -- ₹ for fixed; % for either percentage type
  currency        text NOT NULL DEFAULT 'INR',
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,                            -- null = open-ended
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eca_employee_active_idx
  ON public.employee_commission_agreements (employee_id, is_active);
CREATE INDEX IF NOT EXISTS eca_scope_idx
  ON public.employee_commission_agreements (client_id, service_id);

COMMENT ON TABLE public.employee_commission_agreements IS
  'Per-employee special commission rates for client/service combos. Replaces the contribution-based earning for that employee on matching tasks (where score_percentage > 0).';

-- 2. Earning source tag on contribution_scores (additive, default-valued) -------
ALTER TABLE public.contribution_scores
  ADD COLUMN IF NOT EXISTS earning_source text NOT NULL DEFAULT 'contribution'
    CHECK (earning_source IN ('contribution','agreement','manual_override'));
ALTER TABLE public.contribution_scores
  ADD COLUMN IF NOT EXISTS agreement_id uuid
    REFERENCES public.employee_commission_agreements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contribution_scores.earning_source IS
  'How earnings_inr was derived: contribution (normal), agreement (employee commission agreement), or manual_override.';

-- 3. Permission ----------------------------------------------------------------
INSERT INTO permissions (module, action, key, label, description, display_order) VALUES
  ('employees', 'manage_agreements',
    'employees.manage_agreements',
    'Manage Commission Agreements',
    'Create and edit per-employee commission agreements (special rates for specific client/service combinations).',
    38)
ON CONFLICT (key) DO NOTHING;

INSERT INTO designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM designations d, permissions p
 WHERE d.is_admin = TRUE
   AND p.key = 'employees.manage_agreements'
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;
