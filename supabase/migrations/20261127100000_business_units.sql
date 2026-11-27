-- ============================================================================
-- Business units — Cirqle's departments and sub-brands, their teams, and
-- optional profit-and-loss agreements
-- ============================================================================
-- Additive and idempotent. Safe to re-run. Changes nothing that exists.
--
-- Cirqle is the parent: the owner and the office team see everything. Under
-- it sit UNITS, each run by its own team:
--
--     Cirqle (parent: owner + office team)
--     ├── Social Media & Creative   department · team CQID004, CQID005
--     │                             agreement: owner 40 / CQID004 30 / CQID005 30
--     ├── Cirqle Flyers             department · its own team · no agreement
--     └── Memoura                   sub-brand  · its own team
--
-- A unit's WORK is the service categories it covers (Settings → Departments),
-- so invoices, tasks and clients fall into it with no re-tagging.
--
--   business_units          the unit, the work it covers, how its income is
--                           counted, whether it carries part of General costs,
--                           and whether its team may see its results
--   business_unit_members   its team. A non-admin member is CONFINED: they see
--                           only the unit's clients and work, and open only the
--                           pages a unit team needs (enforced by the app)
--   business_unit_partners  an optional profit-and-loss agreement. With none,
--                           the unit's result stays with Cirqle
--   business_unit_invoices  an invoice counted WHOLE in one unit (a big request
--                           from another unit's client), or left out of all
--   business_unit_entries   a Cash Book entry tagged to one unit, marked
--                           General (split equally), or left out
--   business_unit_settings  one row: Cash Book categories that are General
--                           automatically (subscriptions, tools, domains)
--
-- Nothing here edits a Cash Book entry, an invoice or an employee: tags,
-- assignments and memberships live beside them.
--
-- Server-only tables: RLS on, no browser grants; the app reads and writes them
-- with the service role behind an isAdmin check. The one exception is
-- my_unit_route_lock(), which the sign-in check calls with the signed-in
-- person's own session: it answers only "is the CALLER a unit member?".
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.business_units (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'department' CHECK (kind IN ('department', 'brand')),
  color                 TEXT,
  -- Service categories whose work counts here. A category may belong to only
  -- one active unit (checked by the app).
  category_ids          UUID[] NOT NULL DEFAULT '{}',
  -- 'collected' = money received in the month (default); 'invoiced' = issued.
  revenue_basis         TEXT NOT NULL DEFAULT 'collected' CHECK (revenue_basis IN ('collected', 'invoiced')),
  shares_general_costs  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Members may open the unit's own results page (read-only).
  team_sees_results     BOOLEAN NOT NULL DEFAULT FALSE,
  -- First month of results (always the 1st of a month).
  starts_on             DATE NOT NULL,
  ends_on               DATE,
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  display_order         INTEGER NOT NULL DEFAULT 0,
  created_by            UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_units_slug_key ON public.business_units (slug);

CREATE TABLE IF NOT EXISTS public.business_unit_members (
  unit_id      UUID NOT NULL REFERENCES public.business_units(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (unit_id, employee_id)
);
CREATE INDEX IF NOT EXISTS business_unit_members_employee_idx ON public.business_unit_members (employee_id);

CREATE TABLE IF NOT EXISTS public.business_unit_partners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        UUID NOT NULL REFERENCES public.business_units(id) ON DELETE CASCADE,
  employee_id    UUID NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  share_pct      NUMERIC(6,3) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (unit_id, employee_id)
);
CREATE INDEX IF NOT EXISTS business_unit_partners_unit_idx ON public.business_unit_partners (unit_id);

CREATE TABLE IF NOT EXISTS public.business_unit_invoices (
  invoice_id  UUID PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  -- NULL = counts in no unit (stays with Cirqle).
  unit_id     UUID REFERENCES public.business_units(id) ON DELETE CASCADE,
  note        TEXT,
  created_by  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS business_unit_invoices_unit_idx ON public.business_unit_invoices (unit_id);

CREATE TABLE IF NOT EXISTS public.business_unit_entries (
  entry_id     UUID PRIMARY KEY REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,
  unit_id      UUID REFERENCES public.business_units(id) ON DELETE CASCADE,
  -- General: split equally between the units that carry general costs.
  is_general   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Deliberately in no unit (overrides the automatic rules).
  is_excluded  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactly one of: a unit, General, or excluded.
  CONSTRAINT business_unit_entries_one_kind CHECK (
    (CASE WHEN unit_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN is_general THEN 1 ELSE 0 END)
    + (CASE WHEN is_excluded THEN 1 ELSE 0 END) = 1
  )
);
CREATE INDEX IF NOT EXISTS business_unit_entries_unit_idx ON public.business_unit_entries (unit_id);

CREATE TABLE IF NOT EXISTS public.business_unit_settings (
  id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  general_category_ids  UUID[] NOT NULL DEFAULT '{}',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.business_unit_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.business_units          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_unit_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_unit_partners  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_unit_invoices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_unit_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_unit_settings  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.business_units, public.business_unit_members, public.business_unit_partners,
              public.business_unit_invoices, public.business_unit_entries, public.business_unit_settings
  FROM anon, authenticated;

-- ── Is the signed-in person locked to their unit's pages? ───────────────────
-- Called by the sign-in check (src/lib/supabase/middleware.ts) with the
-- person's own session, which cannot read the tables above. Answers for the
-- CALLER only: true when they belong to an active unit and are not an Admin.
CREATE OR REPLACE FUNCTION public.my_unit_route_lock()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.business_unit_members m
      JOIN public.business_units u ON u.id = m.unit_id AND u.is_active
      JOIN public.employees e ON e.id = m.employee_id
      LEFT JOIN public.designations d ON d.id = e.designation_id
     WHERE e.auth_id = auth.uid()
       AND COALESCE(d.is_admin, FALSE) = FALSE
  );
$$;
REVOKE ALL ON FUNCTION public.my_unit_route_lock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_unit_route_lock() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
