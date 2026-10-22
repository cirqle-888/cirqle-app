-- ═══════════════════════════════════════════════════════════════════════════
-- PROFIT SHARING, CAPITAL & DEVICE VALUATION
--
-- Design: docs/PROFIT-SHARING-DESIGN.md (Revision 5, approved 2026-10-22).
--
-- Profit for sharing is Cirqle's OWN money actually collected, minus genuine
-- operating payments, minus remuneration earned (payroll gross, counted once).
-- 50% of eligible profit (after accumulated losses) forms the distribution
-- pool; the pool splits into Capital Share and Business Reserve (50/50 to
-- start, Admin-configurable, always totalling 100%). Capital Share is divided
-- by time-weighted capital ("capital-days"). Entitlements stay pending until
-- an Admin pays, reinvests or waives them.
--
-- STRICTLY ADDITIVE. Fifteen new tables, three write functions, three
-- permissions, five Cash Book categories (inserted only when missing). Nothing
-- existing is altered: payroll, contributions, ownership, invoices and the
-- Cash Book's own tables and triggers are untouched.
--
-- ADMIN ONLY. Every table has RLS on, no policies, and no grant to anon or
-- authenticated: only the service role (server actions, after a permission +
-- isAdmin check) can read or write. Supabase grants new tables to those roles
-- by default, which is why the REVOKE below is not optional.
--
-- RELATIONSHIP RULES (after the 2026-10-16 PGRST201 outage):
--   · profit_share_members.employee_id is the ONLY foreign key to employees.
--   · profit_share_cash_links.cashbook_entry_id is the ONLY foreign key to
--     cashbook_entries.
--   · Actor columns (created_by, approved_by …) are plain uuids, no FK.
--   · No table has two foreign keys to the same table.
--
-- Rollback: supabase/rollbacks/20261022100000_profit_sharing_down.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Members — founder, employee investors, external investors ──────────
CREATE TABLE IF NOT EXISTS public.profit_share_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid UNIQUE REFERENCES public.employees(id) ON DELETE RESTRICT,
  display_label text,
  roles         text[] NOT NULL,
  joined_on     date,
  exited_on     date,
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['founder','employee','investor']::text[]),
  -- An external investor has no employee row, so it needs a label.
  CHECK (employee_id IS NOT NULL OR nullif(btrim(display_label), '') IS NOT NULL),
  CHECK (exited_on IS NULL OR joined_on IS NULL OR exited_on >= joined_on)
);

COMMENT ON TABLE public.profit_share_members IS
  'Who can hold capital and receive a Capital Share. The only table in the module with a foreign key to employees.';

-- ── 2. Agreements — capital and device-investment terms ────────────────────
-- Legally significant (D12): every term is recorded explicitly and an
-- agreement cannot be approved while one is missing.
CREATE TABLE IF NOT EXISTS public.profit_share_agreements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id                 uuid NOT NULL REFERENCES public.profit_share_members(id) ON DELETE RESTRICT,
  kind                      text NOT NULL CHECK (kind IN ('capital_investment','device_investment')),
  title                     text NOT NULL,
  terms                     text,
  repayment_terms           text,
  entitlements_survive_exit boolean,
  device_capital_weight     numeric(6,4) CHECK (device_capital_weight IS NULL OR (device_capital_weight > 0 AND device_capital_weight <= 1)),
  device_capital_fixed      boolean,
  buyback_terms             text,
  effective_from            date NOT NULL,
  effective_to              date,
  document_url              text,
  professional_review_note  text,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','ended')),
  approved_by               uuid,
  approved_at               timestamptz,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status = 'draft' OR (
    nullif(btrim(repayment_terms), '') IS NOT NULL
    AND entitlements_survive_exit IS NOT NULL
    AND (kind = 'capital_investment' OR (
      device_capital_weight IS NOT NULL
      AND device_capital_fixed IS NOT NULL
      AND nullif(btrim(buyback_terms), '') IS NOT NULL))
  ))
);
CREATE INDEX IF NOT EXISTS profit_share_agreements_member_idx ON public.profit_share_agreements (member_id);

-- ── 3. Settings — versioned, append-only ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_settings (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from               date NOT NULL CHECK (extract(day FROM effective_from) = 1),
  distribution_pct             numeric(5,2) NOT NULL CHECK (distribution_pct >= 0 AND distribution_pct <= 100),
  capital_share_pct            numeric(5,2) NOT NULL CHECK (capital_share_pct >= 0 AND capital_share_pct <= 100),
  reserve_pct                  numeric(5,2) NOT NULL CHECK (reserve_pct >= 0 AND reserve_pct <= 100),
  reconciliation_tolerance_inr numeric(10,2) NOT NULL DEFAULT 1 CHECK (reconciliation_tolerance_inr >= 0),
  ad_prepaid_block_days        integer NOT NULL DEFAULT 60 CHECK (ad_prepaid_block_days > 0),
  passthrough_warn_days        integer NOT NULL DEFAULT 90 CHECK (passthrough_warn_days > 0),
  device_policy                jsonb,
  device_policy_approved_by    uuid,
  device_policy_approved_at    timestamptz,
  note                         text,
  created_by                   uuid,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  -- Capital Share + Business Reserve always total exactly 100% (confirmed).
  CHECK (capital_share_pct + reserve_pct = 100.00),
  CHECK ((device_policy_approved_by IS NULL) = (device_policy_approved_at IS NULL)),
  CHECK (device_policy_approved_at IS NULL OR device_policy IS NOT NULL)
);
-- Several versions may share a month (a device-policy approval does not need
-- a new month); the version in force is the latest effective_from, then the
-- newest row.
CREATE INDEX IF NOT EXISTS profit_share_settings_effective_idx ON public.profit_share_settings (effective_from, created_at);

-- ── 4. Runs — one per profit period ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start               date NOT NULL CHECK (extract(day FROM period_start) = 1),
  period_end                 date NOT NULL,
  status                     text NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','calculated','reviewed','confirmed','void')),
  settings_id                uuid REFERENCES public.profit_share_settings(id) ON DELETE RESTRICT,
  settings_snapshot          jsonb,
  -- D7: the first period's opening accumulated loss is entered by an Admin,
  -- never derived. Later periods take the previous confirmed closing loss.
  opening_loss_inr           numeric(14,2) CHECK (opening_loss_inr IS NULL OR opening_loss_inr >= 0),
  opening_loss_entered       boolean NOT NULL DEFAULT false,
  own_revenue_inr            numeric(14,2),
  operating_payments_inr     numeric(14,2),
  remuneration_inr           numeric(14,2),
  device_costs_inr           numeric(14,2),
  passthrough_writeoffs_inr  numeric(14,2),
  profit_inr                 numeric(14,2),
  loss_offset_inr            numeric(14,2),
  closing_loss_inr           numeric(14,2),
  eligible_profit_inr        numeric(14,2),
  pool_inr                   numeric(14,2),
  capital_share_inr          numeric(14,2),
  reserve_inr                numeric(14,2),
  retained_outside_inr       numeric(14,2),
  total_retained_inr         numeric(14,2),
  unallocated_capital_share_inr numeric(14,2),
  cash_opening_inr           numeric(14,2),
  cash_closing_inr           numeric(14,2),
  free_cash_inr              numeric(14,2),
  cash_available_inr         numeric(14,2),
  summary                    jsonb,
  fingerprint                text,
  calculated_by              uuid,
  calculated_at              timestamptz,
  reviewed_by                uuid,
  reviewed_at                timestamptz,
  cash_ack_text              text,
  cash_ack_by                uuid,
  cash_ack_at                timestamptz,
  confirmed_by               uuid,
  confirmed_at               timestamptz,
  voided_by                  uuid,
  voided_at                  timestamptz,
  void_reason                text,
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  -- Whole months only.
  CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  CHECK (period_end > period_start),
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
                                   AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
                                   AND fingerprint IS NOT NULL AND opening_loss_inr IS NOT NULL)),
  CHECK (status <> 'void' OR (nullif(btrim(void_reason), '') IS NOT NULL AND voided_by IS NOT NULL)),
  -- No two confirmed periods overlap. A range type needs no extension.
  CONSTRAINT profit_share_runs_no_overlap
    EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&) WHERE (status = 'confirmed')
);
CREATE INDEX IF NOT EXISTS profit_share_runs_period_idx ON public.profit_share_runs (period_start, status);

-- ── 5. Frozen inputs of a confirmed run ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_run_inputs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.profit_share_runs(id) ON DELETE RESTRICT,
  source_table text NOT NULL,
  source_id    text NOT NULL,
  class        text NOT NULL,
  amount_inr   numeric(14,2) NOT NULL,
  detail       jsonb
);
CREATE INDEX IF NOT EXISTS profit_share_run_inputs_run_idx ON public.profit_share_run_inputs (run_id);

-- ── 6. Entitlements — one per member per confirmed run ─────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.profit_share_runs(id) ON DELETE RESTRICT,
  member_id    uuid NOT NULL REFERENCES public.profit_share_members(id) ON DELETE RESTRICT,
  capital_days numeric(24,4) NOT NULL DEFAULT 0,
  share        numeric(14,10) NOT NULL DEFAULT 0,
  amount_inr   numeric(14,2) NOT NULL CHECK (amount_inr >= 0),
  workings     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, member_id)
);

-- ── 7. Devices ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_devices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id                   uuid NOT NULL REFERENCES public.profit_share_members(id) ON DELETE RESTRICT,
  ownership                   text NOT NULL CHECK (ownership IN ('employee_owned','company_owned','transferred')),
  category                    text NOT NULL CHECK (category IN ('phone','laptop','tablet','desktop','camera','other')),
  brand                       text,
  model                       text,
  specs                       text,
  serial_number               text,
  purchase_date               date,
  purchase_price_inr          numeric(14,2) CHECK (purchase_price_inr IS NULL OR purchase_price_inr >= 0),
  price_is_estimated          boolean NOT NULL DEFAULT false,
  condition                   text CHECK (condition IN ('excellent','good','fair','poor')),
  usage_start                 date,
  usage_end                   date,
  -- Plain uuid, NOT a foreign key: cash_links holds the module's only FK to
  -- cashbook_entries.
  purchase_cashbook_entry_id  uuid,
  documents                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                       text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (usage_end IS NULL OR usage_start IS NULL OR usage_end >= usage_start)
);
CREATE INDEX IF NOT EXISTS profit_share_devices_member_idx ON public.profit_share_devices (member_id);

CREATE TABLE IF NOT EXISTS public.profit_share_device_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES public.profit_share_devices(id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('repair','maintenance','condition','assigned','returned','transferred','note')),
  event_date   date NOT NULL,
  cost_inr     numeric(14,2) CHECK (cost_inr IS NULL OR cost_inr >= 0),
  paid_by      text CHECK (paid_by IN ('employee','company','none')),
  notes        text,
  document_url text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('repair','maintenance') OR paid_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS profit_share_device_events_device_idx ON public.profit_share_device_events (device_id);

CREATE TABLE IF NOT EXISTS public.profit_share_device_valuations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id             uuid NOT NULL REFERENCES public.profit_share_devices(id) ON DELETE RESTRICT,
  kind                  text NOT NULL CHECK (kind IN ('usage','transfer')),
  window_start          date,
  window_end            date,
  as_of                 date,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','calculated','reviewed','confirmed','settled','reinvested','rejected','waived')),
  settings_id           uuid REFERENCES public.profit_share_settings(id) ON DELETE RESTRICT,
  policy_snapshot       jsonb,
  inputs                jsonb,
  evidence              jsonb,
  usage_basis           text CHECK (usage_basis IN ('estimated','verified')),
  verified_share        numeric(9,6) CHECK (verified_share IS NULL OR (verified_share >= 0 AND verified_share <= 1)),
  verified_reason       text,
  business_share        numeric(9,6),
  value_used_inr        numeric(14,2),
  remaining_life_months numeric(8,2),
  monthly_wear_inr      numeric(14,2),
  proposed_inr          numeric(14,2),
  adjusted_inr          numeric(14,2) CHECK (adjusted_inr IS NULL OR adjusted_inr >= 0),
  adjustment_reason     text,
  outcome               text CHECK (outcome IN ('reimburse','purchase','capital','none')),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  confirmed_by          uuid,
  confirmed_at          timestamptz,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'usage' OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_end >= window_start)),
  CHECK (kind <> 'transfer' OR as_of IS NOT NULL),
  CHECK (adjusted_inr IS NULL OR proposed_inr IS NULL OR adjusted_inr = proposed_inr
         OR nullif(btrim(adjustment_reason), '') IS NOT NULL),
  CHECK (verified_share IS NULL OR nullif(btrim(verified_reason), '') IS NOT NULL),
  CHECK (status NOT IN ('confirmed','settled','reinvested','waived')
         OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND proposed_inr IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS profit_share_device_valuations_device_idx ON public.profit_share_device_valuations (device_id, status);

-- ── 8. Reviews — classification overlay for source rows ────────────────────
-- The source record is never edited. One review per source row.
CREATE TABLE IF NOT EXISTS public.profit_share_reviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table   text NOT NULL,
  source_id      text NOT NULL,
  category       text NOT NULL,
  classification text NOT NULL,
  member_id      uuid REFERENCES public.profit_share_members(id) ON DELETE RESTRICT,
  amount_inr     numeric(14,2),
  source_date    date,
  detail         jsonb,
  note           text,
  reviewed_by    uuid,
  reviewed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);

-- ── 9. Settlements — paid / reinvested / waived / advance offset ───────────
CREATE TABLE IF NOT EXISTS public.profit_share_settlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id      uuid REFERENCES public.profit_share_entitlements(id) ON DELETE RESTRICT,
  device_valuation_id uuid REFERENCES public.profit_share_device_valuations(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('paid','reinvested','waived','advance_offset')),
  amount_inr          numeric(14,2) NOT NULL CHECK (amount_inr > 0),
  settled_on          date NOT NULL,
  review_id           uuid REFERENCES public.profit_share_reviews(id) ON DELETE RESTRICT,
  reason              text,
  cash_ack_text       text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((entitlement_id IS NULL) <> (device_valuation_id IS NULL)),
  CHECK (kind <> 'waived' OR nullif(btrim(reason), '') IS NOT NULL),
  CHECK (kind <> 'advance_offset' OR (review_id IS NOT NULL AND entitlement_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS profit_share_settlements_entitlement_idx ON public.profit_share_settlements (entitlement_id);
CREATE INDEX IF NOT EXISTS profit_share_settlements_device_idx ON public.profit_share_settlements (device_valuation_id);

-- ── 10. Capital — append-only movements ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_capital (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES public.profit_share_members(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('opening_balance','investment','withdrawal','reinvestment',
                                              'device_contribution','correction_in','correction_out')),
  direction     text GENERATED ALWAYS AS (CASE WHEN kind IN ('withdrawal','correction_out') THEN 'out' ELSE 'in' END) STORED,
  amount_inr    numeric(14,2) NOT NULL CHECK (amount_inr > 0),
  weight        numeric(6,4) NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 1),
  received_on   date NOT NULL,
  effective_on  date NOT NULL,
  status        text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected')),
  approved_by   uuid,
  approved_at   timestamptz,
  agreement_id  uuid REFERENCES public.profit_share_agreements(id) ON DELETE RESTRICT,
  settlement_id uuid UNIQUE REFERENCES public.profit_share_settlements(id) ON DELETE RESTRICT,
  review_id     uuid UNIQUE REFERENCES public.profit_share_reviews(id) ON DELETE RESTRICT,
  reason        text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'opening_balance' OR effective_on >= received_on),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (kind NOT IN ('correction_in','correction_out') OR nullif(btrim(reason), '') IS NOT NULL),
  CHECK (kind <> 'device_contribution' OR agreement_id IS NOT NULL),
  CHECK (kind <> 'reinvestment' OR settlement_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS profit_share_capital_member_idx ON public.profit_share_capital (member_id, status, effective_on);

-- ── 11. Cash links — the module's ONLY foreign key to cashbook_entries ─────
-- PK on the entry: one Cash Book entry backs exactly one module record, across
-- capital movements and settlements alike.
CREATE TABLE IF NOT EXISTS public.profit_share_cash_links (
  cashbook_entry_id uuid PRIMARY KEY REFERENCES public.cashbook_entries(id) ON DELETE RESTRICT,
  owner_kind        text NOT NULL CHECK (owner_kind IN ('capital','settlement')),
  owner_id          uuid NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id)
);

-- ── 12. Business Reserve movements ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_reserve_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid REFERENCES public.profit_share_runs(id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('allocation','release','reversal')),
  amount_inr  numeric(14,2) NOT NULL CHECK (amount_inr > 0),
  moved_on    date NOT NULL,
  reason      text,
  approved_by uuid,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Allocations come only from a confirmed run; releases need a reason and an
  -- approving Admin (D9).
  CHECK ((kind = 'allocation') = (run_id IS NOT NULL)),
  CHECK (kind = 'allocation' OR (nullif(btrim(reason), '') IS NOT NULL AND approved_by IS NOT NULL))
);

-- ── 13. Audit events — append-only ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profit_share_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  uuid,
  entity    text NOT NULL,
  entity_id text,
  action    text NOT NULL,
  detail    jsonb
);
CREATE INDEX IF NOT EXISTS profit_share_events_entity_idx ON public.profit_share_events (entity, entity_id);

-- ═══ Guards ════════════════════════════════════════════════════════════════

-- Append-only tables refuse UPDATE and DELETE outright.
CREATE OR REPLACE FUNCTION public.profit_share_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'profit sharing: % is append-only (% refused)', TG_TABLE_NAME, TG_OP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profit_share_settings','profit_share_events','profit_share_reserve_movements',
                           'profit_share_entitlements','profit_share_run_inputs','profit_share_settlements',
                           'profit_share_cash_links']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.profit_share_append_only()', t || '_append_only', t);
  END LOOP;
END $$;

-- Runs: confirmed runs are immutable except a void (no settlements, latest
-- confirmed period only, reason required); void runs are final.
CREATE OR REPLACE FUNCTION public.profit_share_runs_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_prev_end date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('confirmed','void') THEN
      RAISE EXCEPTION 'profit sharing: a % period cannot be deleted', OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'profit sharing: a void period is final';
  END IF;

  IF OLD.status = 'confirmed' THEN
    IF NEW.status <> 'void' THEN
      RAISE EXCEPTION 'profit sharing: a confirmed period is immutable';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status','voided_by','voided_at','void_reason'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','voided_by','voided_at','void_reason']) THEN
      RAISE EXCEPTION 'profit sharing: voiding may change only the void fields';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profit_share_settlements s
                 JOIN public.profit_share_entitlements e ON e.id = s.entitlement_id
                WHERE e.run_id = OLD.id) THEN
      RAISE EXCEPTION 'profit sharing: this period has settlements and cannot be voided';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profit_share_runs r
                WHERE r.status = 'confirmed' AND r.period_start > OLD.period_end) THEN
      RAISE EXCEPTION 'profit sharing: only the latest confirmed period can be voided';
    END IF;
    RETURN NEW;
  END IF;

  -- Becoming confirmed: periods are contiguous and confirmed in order, and the
  -- first one carries an entered opening loss (D7).
  IF NEW.status = 'confirmed' THEN
    SELECT max(period_end) INTO v_prev_end FROM public.profit_share_runs
     WHERE status = 'confirmed' AND id <> NEW.id;
    IF v_prev_end IS NULL THEN
      IF NOT NEW.opening_loss_entered THEN
        RAISE EXCEPTION 'profit sharing: the first period needs an entered opening accumulated loss';
      END IF;
    ELSIF NEW.period_start <> v_prev_end + 1 THEN
      RAISE EXCEPTION 'profit sharing: periods must follow on from % without a gap', v_prev_end;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_runs_guard ON public.profit_share_runs;
CREATE TRIGGER profit_share_runs_guard BEFORE UPDATE OR DELETE ON public.profit_share_runs
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_runs_guard();

-- Capital: approved rows are immutable; approval checks agreement, period and
-- the running balance.
CREATE OR REPLACE FUNCTION public.profit_share_capital_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'profit sharing: approved capital cannot be deleted; record a correction';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('approved','rejected') THEN
    RAISE EXCEPTION 'profit sharing: % capital movements are immutable', OLD.status;
  END IF;

  IF NEW.status = 'approved' THEN
    IF EXISTS (SELECT 1 FROM public.profit_share_runs r
                WHERE r.status = 'confirmed'
                  AND NEW.effective_on BETWEEN r.period_start AND r.period_end) THEN
      RAISE EXCEPTION 'profit sharing: % falls inside a confirmed period; use a date after it', NEW.effective_on;
    END IF;
    IF NEW.kind = 'device_contribution' AND NOT EXISTS (
      SELECT 1 FROM public.profit_share_agreements a
       WHERE a.id = NEW.agreement_id AND a.member_id = NEW.member_id
         AND a.kind = 'device_investment' AND a.status = 'approved'
         AND a.effective_from <= NEW.effective_on
         AND (a.effective_to IS NULL OR a.effective_to >= NEW.effective_on)) THEN
      RAISE EXCEPTION 'profit sharing: device capital needs an approved device-investment agreement in force';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_capital_guard ON public.profit_share_capital;
CREATE TRIGGER profit_share_capital_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profit_share_capital
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_capital_guard();

CREATE OR REPLACE FUNCTION public.profit_share_capital_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_min numeric;
BEGIN
  IF NEW.status <> 'approved' THEN RETURN NEW; END IF;
  -- Same-day movements net before the balance is read.
  WITH daily AS (
    SELECT effective_on, sum(CASE WHEN direction = 'in' THEN amount_inr ELSE -amount_inr END) AS delta
      FROM public.profit_share_capital
     WHERE member_id = NEW.member_id AND status = 'approved'
     GROUP BY effective_on
  ), running AS (
    SELECT sum(delta) OVER (ORDER BY effective_on) AS bal FROM daily
  )
  SELECT min(bal) INTO v_min FROM running;
  IF v_min < 0 THEN
    RAISE EXCEPTION 'profit sharing: this would take the capital balance below zero';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_capital_balance ON public.profit_share_capital;
CREATE TRIGGER profit_share_capital_balance AFTER INSERT OR UPDATE ON public.profit_share_capital
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_capital_balance();

-- Agreements: once approved, only ending it (status + effective_to) is allowed.
CREATE OR REPLACE FUNCTION public.profit_share_agreements_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'profit sharing: only a draft agreement can be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'ended' THEN RAISE EXCEPTION 'profit sharing: an ended agreement is final'; END IF;
  IF OLD.status = 'approved' THEN
    IF NEW.status <> 'ended'
       OR (to_jsonb(NEW) - ARRAY['status','effective_to']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','effective_to']) THEN
      RAISE EXCEPTION 'profit sharing: an approved agreement can only be ended';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_agreements_guard ON public.profit_share_agreements;
CREATE TRIGGER profit_share_agreements_guard BEFORE UPDATE OR DELETE ON public.profit_share_agreements
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_agreements_guard();

-- Reviews: locked once a capital movement or a settlement uses them.
CREATE OR REPLACE FUNCTION public.profit_share_reviews_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profit_share_capital c WHERE c.review_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.profit_share_settlements s WHERE s.review_id = OLD.id) THEN
    RAISE EXCEPTION 'profit sharing: this review is in use and cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_reviews_guard ON public.profit_share_reviews;
CREATE TRIGGER profit_share_reviews_guard BEFORE UPDATE OR DELETE ON public.profit_share_reviews
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_reviews_guard();

-- Device valuations: nothing before Confirmed has any effect; confirming needs
-- an approved device policy (D11) and cannot overlap another confirmed usage
-- window for the same device; after confirmation only the status moves.
CREATE OR REPLACE FUNCTION public.profit_share_valuations_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ownership text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('confirmed','settled','reinvested','waived') THEN
      RAISE EXCEPTION 'profit sharing: a confirmed valuation cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('confirmed','settled','reinvested','waived','rejected') THEN
    IF OLD.status <> 'confirmed' OR NEW.status NOT IN ('confirmed','settled','reinvested','waived')
       OR (to_jsonb(NEW) - ARRAY['status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status']) THEN
      RAISE EXCEPTION 'profit sharing: a % valuation is frozen', OLD.status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'confirmed' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profit_share_settings s
                    WHERE s.id = NEW.settings_id AND s.device_policy_approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'profit sharing: a device valuation needs an approved device policy before it can be confirmed';
    END IF;
    SELECT ownership INTO v_ownership FROM public.profit_share_devices WHERE id = NEW.device_id;
    IF v_ownership <> 'employee_owned' THEN
      RAISE EXCEPTION 'profit sharing: only an employee-owned device can be valued (this one is %)', v_ownership;
    END IF;
    IF NEW.kind = 'usage' AND EXISTS (
      SELECT 1 FROM public.profit_share_device_valuations v
       WHERE v.device_id = NEW.device_id AND v.id <> NEW.id AND v.kind = 'usage'
         AND v.status IN ('confirmed','settled','reinvested','waived')
         AND daterange(v.window_start, v.window_end, '[]') && daterange(NEW.window_start, NEW.window_end, '[]')) THEN
      RAISE EXCEPTION 'profit sharing: this usage window overlaps another confirmed valuation of the same device';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_valuations_guard ON public.profit_share_device_valuations;
CREATE TRIGGER profit_share_valuations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profit_share_device_valuations
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_valuations_guard();

-- Settlements: lock the parent and refuse anything that would settle more than
-- is owed. Σ settlements ≤ entitlement (or confirmed device value), and an
-- advance offset never uses more than the advance has left.
CREATE OR REPLACE FUNCTION public.profit_share_settlements_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_amount numeric;
  v_status text;
  v_used   numeric;
  v_class  text;
BEGIN
  IF NEW.entitlement_id IS NOT NULL THEN
    SELECT e.amount_inr, r.status INTO v_amount, v_status
      FROM public.profit_share_entitlements e
      JOIN public.profit_share_runs r ON r.id = e.run_id
     WHERE e.id = NEW.entitlement_id
       FOR UPDATE OF e;
    IF v_status IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'profit sharing: only an entitlement of a confirmed period can be settled';
    END IF;
    SELECT coalesce(sum(amount_inr), 0) INTO v_used
      FROM public.profit_share_settlements WHERE entitlement_id = NEW.entitlement_id;
  ELSE
    SELECT coalesce(v.adjusted_inr, v.proposed_inr), v.status INTO v_amount, v_status
      FROM public.profit_share_device_valuations v
     WHERE v.id = NEW.device_valuation_id
       FOR UPDATE OF v;
    IF v_status IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'profit sharing: only a confirmed, unsettled valuation can be settled';
    END IF;
    SELECT coalesce(sum(amount_inr), 0) INTO v_used
      FROM public.profit_share_settlements WHERE device_valuation_id = NEW.device_valuation_id;
  END IF;

  IF v_used + NEW.amount_inr > v_amount + 0.004 THEN
    RAISE EXCEPTION 'profit sharing: % exceeds what is still pending (%)', NEW.amount_inr, v_amount - v_used;
  END IF;

  IF NEW.kind = 'advance_offset' THEN
    SELECT classification, amount_inr INTO v_class, v_amount
      FROM public.profit_share_reviews WHERE id = NEW.review_id FOR UPDATE;
    IF v_class IS DISTINCT FROM 'advance_distribution' THEN
      RAISE EXCEPTION 'profit sharing: an advance offset needs a withdrawal reviewed as an advance distribution';
    END IF;
    SELECT coalesce(sum(amount_inr), 0) INTO v_used
      FROM public.profit_share_settlements WHERE review_id = NEW.review_id AND kind = 'advance_offset';
    IF v_used + NEW.amount_inr > v_amount + 0.004 THEN
      RAISE EXCEPTION 'profit sharing: the advance has only % left', v_amount - v_used;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profit_share_settlements_limit ON public.profit_share_settlements;
CREATE TRIGGER profit_share_settlements_limit BEFORE INSERT ON public.profit_share_settlements
  FOR EACH ROW EXECUTE FUNCTION public.profit_share_settlements_limit();

-- ═══ Atomic write functions ════════════════════════════════════════════════
-- Each writes everything for one action in one transaction, so a payment can
-- never exist without its Cash Book link, a reinvestment without its capital
-- row, or a confirmation without its entitlements. Called only by the service
-- role from server actions that have already checked permission + isAdmin.

-- Confirm a period: freeze the run, write entitlements, frozen inputs and the
-- reserve allocation.
CREATE OR REPLACE FUNCTION public.profit_share_confirm_run(
  p_run_id uuid, p_actor uuid, p_result jsonb, p_entitlements jsonb, p_inputs jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_run public.profit_share_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.profit_share_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profit sharing: period not found'; END IF;
  IF v_run.status <> 'reviewed' THEN
    RAISE EXCEPTION 'profit sharing: a period must be reviewed before it is confirmed (it is %)', v_run.status;
  END IF;
  IF v_run.fingerprint IS DISTINCT FROM (p_result->>'fingerprint') THEN
    RAISE EXCEPTION 'profit sharing: the books changed since this period was calculated; recalculate first';
  END IF;

  UPDATE public.profit_share_runs SET
    status = 'confirmed',
    confirmed_by = p_actor,
    confirmed_at = now(),
    opening_loss_inr = (p_result->>'opening_loss_inr')::numeric
  WHERE id = p_run_id;

  INSERT INTO public.profit_share_entitlements (run_id, member_id, capital_days, share, amount_inr, workings)
  SELECT p_run_id, (x->>'member_id')::uuid, (x->>'capital_days')::numeric, (x->>'share')::numeric,
         (x->>'amount_inr')::numeric, x->'workings'
    FROM jsonb_array_elements(coalesce(p_entitlements, '[]'::jsonb)) x;

  INSERT INTO public.profit_share_run_inputs (run_id, source_table, source_id, class, amount_inr, detail)
  SELECT p_run_id, x->>'source_table', x->>'source_id', x->>'class', (x->>'amount_inr')::numeric, x->'detail'
    FROM jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb)) x;

  IF coalesce((p_result->>'reserve_inr')::numeric, 0) > 0 THEN
    INSERT INTO public.profit_share_reserve_movements (run_id, kind, amount_inr, moved_on, reason, created_by)
    VALUES (p_run_id, 'allocation', (p_result->>'reserve_inr')::numeric, v_run.period_end,
            'Business Reserve allocation for the confirmed period', p_actor);
  END IF;

  INSERT INTO public.profit_share_events (actor_id, entity, entity_id, action, detail)
  VALUES (p_actor, 'run', p_run_id::text, 'confirmed', p_result);
END $$;

-- Settle an entitlement or a confirmed device valuation.
--   p: { entitlement_id | device_valuation_id, kind, amount_inr, settled_on,
--        reason?, cash_ack_text?, review_id?, actor,
--        cash: { mode: 'create' | 'link', entry_id?, bank_account_id?, account_code?, description? } }
CREATE OR REPLACE FUNCTION public.profit_share_settle(p jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id         uuid;
  v_actor      uuid := (p->>'actor')::uuid;
  v_kind       text := p->>'kind';
  v_amount     numeric := (p->>'amount_inr')::numeric;
  v_date       date := (p->>'settled_on')::date;
  v_member     uuid;
  v_agreement  uuid;
  v_weight     numeric := 1;
  v_entry      uuid;
  v_category   uuid;
  v_val        public.profit_share_device_valuations%ROWTYPE;
  v_pending    numeric;
BEGIN
  INSERT INTO public.profit_share_settlements
    (entitlement_id, device_valuation_id, kind, amount_inr, settled_on, review_id, reason, cash_ack_text, created_by)
  VALUES ((p->>'entitlement_id')::uuid, (p->>'device_valuation_id')::uuid, v_kind, v_amount, v_date,
          (p->>'review_id')::uuid, p->>'reason', p->>'cash_ack_text', v_actor)
  RETURNING id INTO v_id;

  IF (p->>'entitlement_id') IS NOT NULL THEN
    SELECT member_id INTO v_member FROM public.profit_share_entitlements WHERE id = (p->>'entitlement_id')::uuid;
  ELSE
    SELECT * INTO v_val FROM public.profit_share_device_valuations WHERE id = (p->>'device_valuation_id')::uuid;
    SELECT member_id INTO v_member FROM public.profit_share_devices WHERE id = v_val.device_id;
  END IF;

  IF v_kind = 'paid' THEN
    IF (p->'cash'->>'mode') = 'link' THEN
      v_entry := (p->'cash'->>'entry_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.cashbook_entries WHERE id = v_entry AND deleted_at IS NULL AND type = 'outflow') THEN
        RAISE EXCEPTION 'profit sharing: the Cash Book entry to link must be a live outflow';
      END IF;
    ELSIF (p->'cash'->>'mode') = 'create' THEN
      SELECT id INTO v_category FROM public.cashbook_categories
       WHERE account_code = p->'cash'->>'account_code' AND coalesce(is_active, true)
       ORDER BY created_at NULLS LAST LIMIT 1;
      IF v_category IS NULL THEN
        RAISE EXCEPTION 'profit sharing: Cash Book category % is missing', p->'cash'->>'account_code';
      END IF;
      -- Neutral description and no employee_id: the entry must not identify
      -- the investor to Cash Book viewers, and must never be offered for
      -- payslip allocation.
      INSERT INTO public.cashbook_entries
        (type, category_id, bank_account_id, amount, amount_inr, currency, exchange_rate,
         entry_date, description, reference, scope)
      VALUES ('outflow', v_category, (p->'cash'->>'bank_account_id')::uuid, v_amount, v_amount, 'INR', 1,
              v_date, coalesce(nullif(p->'cash'->>'description', ''), 'Profit share settlement'),
              'profit_share:' || v_id::text, 'company')
      RETURNING id INTO v_entry;
    ELSE
      RAISE EXCEPTION 'profit sharing: a payment needs a Cash Book entry (create or link)';
    END IF;
    INSERT INTO public.profit_share_cash_links (cashbook_entry_id, owner_kind, owner_id, created_by)
    VALUES (v_entry, 'settlement', v_id, v_actor);
  END IF;

  IF v_kind = 'reinvested' THEN
    IF (p->>'device_valuation_id') IS NOT NULL THEN
      -- D10: device usage value becomes capital only under an approved
      -- written device-investment agreement in force on the date.
      SELECT a.id, a.device_capital_weight INTO v_agreement, v_weight
        FROM public.profit_share_agreements a
       WHERE a.member_id = v_member AND a.kind = 'device_investment' AND a.status = 'approved'
         AND a.effective_from <= v_date AND (a.effective_to IS NULL OR a.effective_to >= v_date)
       ORDER BY a.effective_from DESC LIMIT 1;
      IF v_agreement IS NULL THEN
        RAISE EXCEPTION 'profit sharing: reinvesting device value needs an approved device-investment agreement';
      END IF;
      INSERT INTO public.profit_share_capital
        (member_id, kind, amount_inr, weight, received_on, effective_on, status, approved_by, approved_at,
         agreement_id, settlement_id, notes, created_by)
      VALUES (v_member, 'device_contribution', v_amount, coalesce(v_weight, 1), v_date, v_date, 'approved', v_actor, now(),
              v_agreement, v_id, 'Device usage value reinvested', v_actor);
    ELSE
      INSERT INTO public.profit_share_capital
        (member_id, kind, amount_inr, received_on, effective_on, status, approved_by, approved_at,
         settlement_id, notes, created_by)
      VALUES (v_member, 'reinvestment', v_amount, v_date, v_date, 'approved', v_actor, now(),
              v_id, 'Profit share reinvested', v_actor);
    END IF;
  END IF;

  -- A device valuation leaves Confirmed once nothing is pending.
  IF (p->>'device_valuation_id') IS NOT NULL THEN
    SELECT coalesce(v_val.adjusted_inr, v_val.proposed_inr) - coalesce(sum(amount_inr), 0) INTO v_pending
      FROM public.profit_share_settlements WHERE device_valuation_id = v_val.id;
    IF v_pending <= 0.004 THEN
      UPDATE public.profit_share_device_valuations
         SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM public.profit_share_settlements
                             WHERE device_valuation_id = v_val.id AND kind <> 'reinvested') THEN 'reinvested'
           WHEN NOT EXISTS (SELECT 1 FROM public.profit_share_settlements
                             WHERE device_valuation_id = v_val.id AND kind <> 'waived') THEN 'waived'
           ELSE 'settled' END
       WHERE id = v_val.id;
    END IF;
  END IF;

  INSERT INTO public.profit_share_events (actor_id, entity, entity_id, action, detail)
  VALUES (v_actor, 'settlement', v_id::text, v_kind, p - 'actor');
  RETURN v_id;
END $$;

-- Record a capital movement, optionally linked to an existing Cash Book entry.
CREATE OR REPLACE FUNCTION public.profit_share_record_capital(p jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid;
  v_actor uuid := (p->>'actor')::uuid;
BEGIN
  INSERT INTO public.profit_share_capital
    (member_id, kind, amount_inr, weight, received_on, effective_on, agreement_id, review_id, reason, notes, created_by)
  VALUES ((p->>'member_id')::uuid, p->>'kind', (p->>'amount_inr')::numeric, coalesce((p->>'weight')::numeric, 1),
          (p->>'received_on')::date, (p->>'effective_on')::date, (p->>'agreement_id')::uuid,
          (p->>'review_id')::uuid, p->>'reason', p->>'notes', v_actor)
  RETURNING id INTO v_id;

  IF (p->>'cashbook_entry_id') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.cashbook_entries
                    WHERE id = (p->>'cashbook_entry_id')::uuid AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'profit sharing: the Cash Book entry to link was not found';
    END IF;
    INSERT INTO public.profit_share_cash_links (cashbook_entry_id, owner_kind, owner_id, created_by)
    VALUES ((p->>'cashbook_entry_id')::uuid, 'capital', v_id, v_actor);
  END IF;

  INSERT INTO public.profit_share_events (actor_id, entity, entity_id, action, detail)
  VALUES (v_actor, 'capital', v_id::text, 'recorded', p - 'actor');
  RETURN v_id;
END $$;

-- The functions are for the service role only. PUBLIC can EXECUTE new
-- functions by default, so take that away explicitly.
REVOKE ALL ON FUNCTION public.profit_share_confirm_run(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profit_share_settle(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profit_share_record_capital(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profit_share_confirm_run(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.profit_share_settle(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.profit_share_record_capital(jsonb) TO service_role;

-- ═══ Access: service role only ═════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profit_share_members','profit_share_agreements','profit_share_settings','profit_share_runs',
    'profit_share_run_inputs','profit_share_entitlements','profit_share_devices','profit_share_device_events',
    'profit_share_device_valuations','profit_share_reviews','profit_share_settlements','profit_share_capital',
    'profit_share_cash_links','profit_share_reserve_movements','profit_share_events']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.profit_share_events_id_seq TO service_role;

-- ═══ Permissions — Admin only in this release ══════════════════════════════
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('profit_sharing', 'view', 'profit_sharing.view', 'View Profit Sharing',
   'See company cash profit, capital, entitlements and device valuations. Admin only in this release.', 64),
  ('profit_sharing', 'manage', 'profit_sharing.manage', 'Manage Profit Sharing',
   'Record investors, capital, reviews, devices and draft periods.', 65),
  ('profit_sharing', 'approve', 'profit_sharing.approve', 'Approve Profit Sharing',
   'Approve capital and agreements, confirm periods and valuations, settle, waive and change settings.', 66)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.designation_permissions (designation_id, permission_id, allowed)
SELECT d.id, p.id, TRUE
  FROM public.designations d, public.permissions p
 WHERE d.is_admin = TRUE
   AND p.key IN ('profit_sharing.view','profit_sharing.manage','profit_sharing.approve')
ON CONFLICT (designation_id, permission_id) DO UPDATE SET allowed = TRUE;

-- ═══ Cash Book categories (D8) — only when missing, never altered ══════════
DO $$
DECLARE
  has_cols boolean;
BEGIN
  SELECT count(*) = 3 INTO has_cols FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'cashbook_categories'
     AND column_name IN ('statement_section','account_code','default_scope');

  IF has_cols THEN
    INSERT INTO public.cashbook_categories (name, type, statement_section, account_code, default_scope, is_active)
    SELECT v.name, v.type, v.section, v.code, 'company', true
      FROM (VALUES
        ('Capital Introduced',  'inflow',  'financial', 'financial.capital_introduced'),
        ('Capital Withdrawn',   'outflow', 'excluded',  'excluded.capital_withdrawal'),
        ('Profit Share Payout', 'outflow', 'excluded',  'excluded.profit_distribution'),
        ('Loan Received',       'inflow',  'financial', 'financial.loan_received'),
        ('Loan Repaid',         'outflow', 'financial', 'financial.loan_repaid')
      ) AS v(name, type, section, code)
     WHERE NOT EXISTS (SELECT 1 FROM public.cashbook_categories c WHERE lower(c.name) = lower(v.name));
  ELSE
    RAISE NOTICE 'profit sharing: cashbook_categories has no classification columns; categories not seeded';
  END IF;
END $$;

-- ═══ Settings version 1 ════════════════════════════════════════════════════
-- 50% distributed; Capital Share 50% / Business Reserve 50% of the pool;
-- ₹1.00 reconciliation tolerance; unassigned ad funding blocks after 60 days.
-- No device policy: device valuations stay draft-only until one is approved.
INSERT INTO public.profit_share_settings
  (effective_from, distribution_pct, capital_share_pct, reserve_pct,
   reconciliation_tolerance_inr, ad_prepaid_block_days, passthrough_warn_days, note)
SELECT '2000-01-01', 50, 50, 50, 1, 60, 90, 'Initial settings (confirmed 2026-10-22)'
 WHERE NOT EXISTS (SELECT 1 FROM public.profit_share_settings);

COMMIT;
