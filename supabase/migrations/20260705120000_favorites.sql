-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Favorites — generic, per-employee quick-access framework                 ║
-- ║                                                                            ║
-- ║  A single table backs favoriting of whole nav pages ('nav_page') as well  ║
-- ║  as specific records (business partners, campaigns, employees, ...). Any  ║
-- ║  future module adopts this with zero schema changes — just a new          ║
-- ║  entity_type value and a <FavoriteToggle> on its detail page.             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_favorites (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id   UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,   -- 'nav_page' | 'business_partner' | 'campaign' | 'employee' | ... (open-ended)
  entity_id     TEXT,            -- null for nav_page; the record's id otherwise
  href          TEXT NOT NULL,   -- stable destination URL
  label         TEXT NOT NULL,   -- cached display label at pin-time
  icon_key      TEXT NOT NULL,   -- lucide icon name, resolved client-side via a lookup map
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS employee_favorites_employee_idx
  ON public.employee_favorites (employee_id, position);

-- RLS: every query is always scoped server-side to the caller's own
-- employee_id (resolved via resolveCurrentEmployeeId(), never client-supplied),
-- so the simple "authenticated ALL" pattern used by recent tables
-- (business_partners, ad_wallet_ledger) is safe here too.
ALTER TABLE public.employee_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "employee_favorites_select" ON public.employee_favorites;
CREATE POLICY "employee_favorites_select" ON public.employee_favorites
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "employee_favorites_write" ON public.employee_favorites;
CREATE POLICY "employee_favorites_write" ON public.employee_favorites
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
