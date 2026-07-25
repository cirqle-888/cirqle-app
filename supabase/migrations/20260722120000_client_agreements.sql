-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENT AGREEMENTS — Phase 1 foundation
-- Design: CLIENT_AGREEMENTS_DESIGN.md (APPROVED v2, 2026-07-22)
--
-- Agreements are the parent commercial object above the existing
-- Calendar → Request → Task → Invoice spine. Six tables. STRICTLY ADDITIVE:
-- nothing existing is altered, and with no agreement rows every existing
-- flow behaves exactly as before.
--
-- Two structural rules this schema encodes (see design §2.3, §3):
--   1. Progress is NEVER stored — committed/planned/delivered/remaining are
--      always computed live through the calendar→request→task join.
--   2. Items are TEMPORAL term rows: once an agreement is active, terms are
--      never UPDATEd — a change closes the row (effective_to) and inserts a
--      successor. Historical months always resolve their own terms.
--      (Same effective-dating pattern as employee_commission_agreements.)
--
-- Conventions match 20260628120000_advertising_module.sql: BEGIN/COMMIT,
-- CREATE TABLE IF NOT EXISTS, gen_random_uuid() PKs, RLS "authenticated all"
-- policy (real authorization is app-level permission guards), permission
-- catalog inserts + admin designation auto-grant, soft delete via deleted_at.
-- Rollback: supabase/rollbacks/20260722120000_client_agreements_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Agreements (the parent commercial object) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_agreements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_number    TEXT NOT NULL UNIQUE,        -- AGR-{YYMM}-{clientCode}, dup suffix A/-2/-3
  client_id           UUID NOT NULL REFERENCES public.clients(id)    ON DELETE CASCADE,
  quotation_id        UUID          REFERENCES public.quotations(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  -- 'pending_approval' is reserved for the future approvals-engine integration
  -- (design §5.2); nothing transitions into it in Phase 1.
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_approval','active','paused',
                                        'completed','cancelled','expired')),
  start_date          DATE NOT NULL,
  end_date            DATE,                        -- NULL = open-ended (month-to-month)
  renewal_type        TEXT NOT NULL DEFAULT 'manual'
                      CHECK (renewal_type IN ('none','manual','auto')),
  signed_document_url TEXT,
  public_token        UUID UNIQUE DEFAULT gen_random_uuid(),   -- future client portal
  notes               TEXT,
  created_by          UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ                  -- soft delete (house norm)
);
CREATE INDEX IF NOT EXISTS client_agreements_client_idx
  ON public.client_agreements (client_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS client_agreements_expiry_idx
  ON public.client_agreements (end_date) WHERE deleted_at IS NULL AND status = 'active';

-- ── 2. Items — TEMPORAL term rows ────────────────────────────────────────────
--     A row is ONE TERM WINDOW of a committed service package. While the
--     agreement is draft/pending_approval the row may be edited in place;
--     from activation onward changes go through close-and-replace only.
CREATE TABLE IF NOT EXISTS public.client_agreement_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        UUID NOT NULL REFERENCES public.client_agreements(id) ON DELETE CASCADE,
  service_id          UUID          REFERENCES public.services(id)          ON DELETE SET NULL,
  commitment_type     TEXT NOT NULL DEFAULT 'retainer'
                      CHECK (commitment_type IN ('one_time','retainer')),
  committed_quantity  NUMERIC(10,2),               -- headline fallback; when deliverables
                                                   -- exist THEY are the committed source
  -- Phase 1 engine + UI ship 'monthly' ONLY; the other values are reserved so
  -- no CHECK migration is needed later (design §3.2 rule 6).
  cycle               TEXT CHECK (cycle IN ('monthly','quarterly','yearly')),
  effective_from      DATE NOT NULL,               -- term window start
  effective_to        DATE,                        -- NULL = current term
  unit_price          NUMERIC(14,2),               -- package fee (one_time) / fee per cycle (retainer)
  currency            TEXT NOT NULL DEFAULT 'INR',
  carry_forward_rule  TEXT NOT NULL DEFAULT 'expire'
                      CHECK (carry_forward_rule IN ('expire','carry_forward','manual')),
  extra_unit_price    NUMERIC(14,2),               -- NULL = extra work is not auto-billable
  display_order       INT  NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_items_agreement_idx
  ON public.client_agreement_items (agreement_id);
CREATE INDEX IF NOT EXISTS client_agreement_items_service_idx
  ON public.client_agreement_items (service_id);
CREATE INDEX IF NOT EXISTS client_agreement_items_term_idx
  ON public.client_agreement_items (agreement_id, effective_from);

-- ── 3. Deliverables (typed quota lines under an item) ────────────────────────
--     content_types values use the social calendar vocabulary
--     ('post','reel','story','carousel','video','flyer','poster','blog',
--      'seo','ad','email','other'); app-enforced, matching the calendar's own
--     unconstrained variants column. '{}' = count by the item's service only.
CREATE TABLE IF NOT EXISTS public.client_agreement_deliverables (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,               -- "Feed Posts", "Stories", "Monthly Report"
  content_types       TEXT[] NOT NULL DEFAULT '{}',
  committed_quantity  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- per cycle (retainer) / absolute (one_time)
  display_order       INT NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_deliverables_item_idx
  ON public.client_agreement_deliverables (item_id);

-- ── 4. Milestones (one-time projects: Research → Concept → … → Final Files) ──
CREATE TABLE IF NOT EXISTS public.client_agreement_milestones (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  display_order       INT NOT NULL DEFAULT 0,
  due_date            DATE,                                                     -- health-score input
  -- Default 'internal': client-visible milestones must be explicitly marked
  -- 'client' (approved decision, design §12 #9).
  visibility          TEXT NOT NULL DEFAULT 'internal'
                      CHECK (visibility IN ('internal','client')),
  task_id             UUID REFERENCES public.tasks(id)     ON DELETE SET NULL,  -- linked ⇒ status derives from task
  completed_at        TIMESTAMPTZ,                                              -- unlinked ⇒ manual check-off
  completed_by        UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_milestones_item_idx
  ON public.client_agreement_milestones (item_id);

-- ── 5. Task link (reuse the existing tasks table; never duplicate it) ────────
--     Direct copy of ad_project_tasks (20260628120000).
CREATE TABLE IF NOT EXISTS public.client_agreement_tasks (
  item_id     UUID NOT NULL REFERENCES public.client_agreement_items(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES public.tasks(id)                  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, task_id)
);
CREATE INDEX IF NOT EXISTS client_agreement_tasks_task_idx
  ON public.client_agreement_tasks (task_id);

-- ── 6. Events (timeline; direct copy of request_activity's shape) ────────────
--     AUDIT ONLY. The writer never throws (best-effort); nothing computational
--     may ever read from this table (design §2.3 / §3.3).
CREATE TABLE IF NOT EXISTS public.client_agreement_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES public.client_agreements(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('client','admin','system')),
  actor_id      UUID,                              -- employee id when actor_type = 'admin'
  actor_label   TEXT,
  action        TEXT NOT NULL,                     -- created | updated | quotation_linked | activated
                                                   -- | item_added | item_updated | item_removed
                                                   -- | term_changed | renewed | paused | resumed
                                                   -- | completed | cancelled | expired | adjustment | note
  visibility    TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  detail        JSONB,                             -- {field,from,to} | {message} | {from_item_id,to_item_id}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_agreement_events_agreement_idx
  ON public.client_agreement_events (agreement_id, visibility, created_at);

-- ── 7. RLS (house pattern: permissive; real authz is app-level guards) ───────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client_agreements','client_agreement_items','client_agreement_deliverables',
    'client_agreement_milestones','client_agreement_tasks','client_agreement_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── 8. Permissions (band 85-87 — requests use 60-66, ads 70-77, and the
--     social calendar already took 80-81 in 20260716120000) ──────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('agreements', 'view',         'agreements.view',         'View Agreements',
    'See client agreements, deliverables and progress',                        85),
  ('agreements', 'manage',       'agreements.manage',       'Manage Agreements',
    'Create and edit client agreements, items, deliverables and milestones',   86),
  ('agreements', 'view_pricing', 'agreements.view_pricing', 'View Agreement Pricing',
    'See fees and prices on client agreements',                                87)
ON CONFLICT (key) DO NOTHING;

-- Grant every agreements permission to admin designations (mirrors advertising).
INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('agreements.view','agreements.manage','agreements.view_pricing')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ── 9. Missing composite index on the engine's hottest read path ─────────────
--     tasks carries only single-column indexes on client_id / service_id /
--     task_date today (20260528090000_performance_indexes.sql); delivered-per-
--     client-service-month needs the composite. Additive; safe on a live table.
CREATE INDEX IF NOT EXISTS idx_tasks_client_service_date
  ON public.tasks (client_id, service_id, task_date) WHERE deleted_at IS NULL;

COMMIT;
