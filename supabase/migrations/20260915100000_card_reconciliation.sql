-- Credit cards, and reconciling a statement against what the app recorded.
--
-- THE PROBLEM THIS SOLVES. A statement line is a PURCHASE. Until now the app
-- recorded the BILL PAYMENT, described by what the purchase was for:
--
--   2025-10-01   434.13   Paid Credit Card Payment for Host Purchase
--   2025-10-01   281.71   Paid Credit Card Payment for Domain Purchase
--   2026-06-25  2286.83   Paid to One Card for Purchased Amount for Claude
--
-- Three things follow, and all three are why a statement could not be
-- reconciled against anything:
--   · the expense lands in the month the BILL was paid, not the month it was
--     charged, so a September subscription is an October cost;
--   · there is no card balance, so what is owed is invisible;
--   · nothing in the app corresponds to a statement line, so "did we record
--     this charge" has no answer short of reading both lists side by side.
--
-- THE MODEL. A card is an ACCOUNT, and a liability rather than a pot of money.
--   · A purchase is an outflow ON THE CARD, dated the day it was charged.
--     That is the expense — categorised, client-allocated, marked up, exactly
--     as any other. Cash has not moved.
--   · Paying the bill is a TRANSFER, bank → card. It is not an expense, and
--     the app already knows how to do this: two entries sharing a
--     `transfer_ref`, already excluded from expense counting
--     (cashbook/actions.ts). This migration adds no second mechanism for it.
--   · The card's balance is therefore purchases − payments, which is what is
--     owed, and every statement line has an app row it can be matched to.
--
-- NOTHING HISTORICAL MOVES. `reconcile_from` on the account is the date the
-- card starts being reconciled; entries before it are left exactly as they
-- are. Several 2024 and 2025 months have paid payroll and July 2026 has a
-- profit snapshot, all computed from today's figures — restating card spend
-- across those months would silently contradict them.

BEGIN;

-- ── 1. A bank account may now be a credit card ──────────────────────────────
-- `type` is free text here (the settings form offers bank/cash/wallet/other),
-- so 'credit_card' needs no constraint change. These columns are meaningless
-- for every other type and stay NULL there.
ALTER TABLE public.bank_accounts
  -- Day of the month the statement closes. 16 means a cycle of the 16th to
  -- the 15th. A day later than a short month has is clamped to its last day
  -- (see src/lib/cards/cycle.ts) rather than rolling into the next month.
  ADD COLUMN IF NOT EXISTS statement_day  INT
    CHECK (statement_day IS NULL OR (statement_day BETWEEN 1 AND 31)),
  -- Day the bill is due. Shown, never used in arithmetic.
  ADD COLUMN IF NOT EXISTS due_day        INT
    CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
  ADD COLUMN IF NOT EXISTS credit_limit   NUMERIC(14,2),
  -- Last four digits, for telling two cards apart on screen. Not a secret and
  -- deliberately not the full number: the app has no reason to hold one.
  ADD COLUMN IF NOT EXISTS card_last4     TEXT
    CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  -- The clean start. Statements before this date are not expected to
  -- reconcile, because the entries behind them predate the card model.
  ADD COLUMN IF NOT EXISTS reconcile_from DATE;

COMMENT ON COLUMN public.bank_accounts.statement_day IS
  'Credit cards only: day of month the billing cycle closes. NULL for every other account type.';
COMMENT ON COLUMN public.bank_accounts.reconcile_from IS
  'Credit cards only: the date reconciliation begins. Entries before it are left untouched by design.';

-- ── 2. One imported statement — one card, one billing cycle ─────────────────
CREATE TABLE IF NOT EXISTS public.card_statements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id  UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,

  -- The cycle this statement covers, inclusive of both ends. Derived from the
  -- card's statement_day but STORED, because a bank occasionally shifts a
  -- cycle and the stored dates must keep describing what was actually imported.
  cycle_start      DATE NOT NULL,
  cycle_end        DATE NOT NULL CHECK (cycle_end >= cycle_start),

  -- What the statement itself says is owed for the cycle. Typed by a person
  -- from the statement, and the number the reconciliation must arrive at.
  -- NULL until they enter it: a cycle can be imported and matched before
  -- anyone reads the total off the PDF.
  statement_total  NUMERIC(14,2),
  currency         TEXT NOT NULL DEFAULT 'INR',

  -- 'open'   — being worked on.
  -- 'closed' — every line accounted for and the totals agreed. Closing is a
  --            deliberate act and is what stops a cycle being re-imported.
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'closed')),

  notes            TEXT,
  imported_by      UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  closed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One statement per card per cycle. A second import of the same cycle is a
  -- mistake, not a new statement.
  UNIQUE (bank_account_id, cycle_end)
);

CREATE INDEX IF NOT EXISTS card_statements_account_idx
  ON public.card_statements (bank_account_id, cycle_end DESC);

-- ── 3. The lines on it ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.card_statement_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id  UUID NOT NULL REFERENCES public.card_statements(id) ON DELETE CASCADE,

  txn_date      DATE NOT NULL,
  description   TEXT NOT NULL,

  -- POSITIVE is a charge, NEGATIVE is a credit (a refund, a reversal, the
  -- bill payment itself where the bank lists it). Signed rather than a
  -- separate type column, so the cycle total is a plain SUM.
  amount        NUMERIC(14,2) NOT NULL,

  -- The source text this line was parsed from, kept verbatim. When a parse
  -- goes wrong the original is the only way to see how, and a person editing
  -- a line should be able to compare it against what the bank actually sent.
  raw           TEXT,

  -- 'ignored' is for a line that legitimately has no app entry: the bill
  -- payment appearing on the card's own statement, an annual fee already
  -- recorded elsewhere. Ignoring is a decision, recorded with its reason,
  -- never a silent skip.
  status        TEXT NOT NULL DEFAULT 'unmatched'
                  CHECK (status IN ('unmatched', 'matched', 'ignored')),
  ignore_reason TEXT,

  display_order INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS card_statement_lines_statement_idx
  ON public.card_statement_lines (statement_id, display_order);
CREATE INDEX IF NOT EXISTS card_statement_lines_status_idx
  ON public.card_statement_lines (statement_id, status);

-- ── 4. What each line was matched to ────────────────────────────────────────
-- MANY rows per line on purpose. One charge is often several app entries,
-- because a single card payment gets split so each part can carry its own
-- category and client:
--
--   statement   715.84  GODADDY
--   app         434.13  Hosting  (Cirqle.work)
--   app         281.71  Domain   (Cirqle.work)
--
-- so the relationship is line → entries, summing to the line's amount.
CREATE TABLE IF NOT EXISTS public.card_statement_matches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id            UUID NOT NULL REFERENCES public.card_statement_lines(id) ON DELETE CASCADE,
  cashbook_entry_id  UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,

  -- 'auto'   — the matcher proposed it and a person accepted the batch.
  -- 'manual' — a person picked this entry for this line themselves.
  -- Kept so a wrong auto-match can be found later without re-deriving it.
  matched_by         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (matched_by IN ('auto', 'manual')),

  matched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_by_user    UUID REFERENCES public.employees(id) ON DELETE SET NULL,

  UNIQUE (line_id, cashbook_entry_id)
);

-- An entry belongs to ONE statement line. Without this a single expense could
-- be counted against two different charges and both cycles would appear to
-- balance while the books did not.
CREATE UNIQUE INDEX IF NOT EXISTS card_statement_matches_entry_idx
  ON public.card_statement_matches (cashbook_entry_id);

CREATE INDEX IF NOT EXISTS card_statement_matches_line_idx
  ON public.card_statement_matches (line_id);

COMMENT ON TABLE public.card_statement_matches IS
  'Statement line to cashbook entry. Several entries per line is the normal case — one charge split so each part carries its own category.';

-- ── 5. RLS (house pattern: permissive; real authz is app-level guards) ──────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['card_statements','card_statement_lines','card_statement_matches']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_authenticated_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_authenticated_all', t);
  END LOOP;
END $$;

-- ── 6. Permissions ─────────────────────────────────────────────────────────
INSERT INTO public.permissions (module, action, key, label, description, display_order) VALUES
  ('card_reconciliation', 'view',   'card_reconciliation.view',   'View Card Reconciliation',
    'Open credit card statements and see how they reconcile',              89),
  ('card_reconciliation', 'manage', 'card_reconciliation.manage', 'Reconcile Card Statements',
    'Import statements, match lines to entries, and close a billing cycle', 90)
ON CONFLICT (key) DO NOTHING;

COMMIT;
