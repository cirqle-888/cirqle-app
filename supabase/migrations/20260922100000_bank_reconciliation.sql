-- Bank accounts, and reconciling a statement against what the app recorded.
--
-- THE QUESTION THIS ANSWERS. "Does the cash book agree with the bank?" — and
-- when it does not, WHICH transactions disagree and in which direction. Until
-- now that could only be answered by reading a PDF and the cash book side by
-- side, which is slow enough that it does not get done, and error-prone enough
-- that doing it does not settle much.
--
-- WHY THIS IS NOT THE CARD TABLES WITH A WIDER CHECK CONSTRAINT. Three things
-- differ, and each of them is load-bearing:
--
--   · A CARD bills on a cycle the issuer chose, so `card_statements` derives
--     its window from the account's statement_day. A BANK statement covers
--     whatever range was asked for — a month, a quarter, a financial year, the
--     stretch between two dates. The period here is simply stored.
--   · A card statement states ONE total for the cycle. A bank statement states
--     an OPENING and a CLOSING balance, which is a much stronger check: the
--     lines are fully constrained between them, so a dropped or reversed line
--     is caught by arithmetic alone, before the cash book is consulted at all.
--   · The SIGN of the word "debit" is opposite on the two. On a card a debit
--     raises what is owed; on a bank account it lowers what is held. Sharing a
--     table would mean a single `amount` column meaning two different things
--     depending on a join, which is the kind of subtlety that survives review
--     and then quietly doubles a variance.
--
-- The one rule both share, and the reason both are trustworthy, lives in the
-- database rather than in application good intentions: ONE ENTRY BELONGS TO
-- ONE LINE. Without it a single payment could be counted against two different
-- statement lines and both periods would appear to balance while the books did
-- not.
--
-- NOTHING HISTORICAL MOVES. `reconcile_from` on the account (added by
-- 20260915100000 for cards, and meaningful for every account type) is the date
-- reconciliation begins. Entries before it are left exactly as they are.

BEGIN;

-- ── 1. What a bank account needs to be reconciled ───────────────────────────
-- `opening_balance` already exists and is the balance the ACCOUNT opened with.
-- That is a different number from the balance a given STATEMENT opened with,
-- which is why the latter lives on the statement row and not here.
--
-- `reconcile_from` is ADDED here rather than assumed. The card migration
-- (20260915100000) also adds it, and an earlier draft of this file took that
-- as given and merely commented on it — which failed outright on a database
-- where the card migration had never been run. Both use
-- ADD COLUMN IF NOT EXISTS, so whichever runs first creates it and the other
-- is a no-op; neither now depends on the other having been applied, and they
-- can be applied in either order or not at all.
ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS reconcile_from DATE;

COMMENT ON COLUMN public.bank_accounts.reconcile_from IS
  'The date reconciliation begins for this account, card or bank. Entries before it are left untouched by design.';

-- ── 2. One imported statement — one account, one period ─────────────────────
CREATE TABLE IF NOT EXISTS public.bank_statements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id  UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,

  -- The range this statement covers, inclusive of both ends, exactly as the
  -- bank printed it. Not derived from anything: see the header.
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL CHECK (period_end >= period_start),

  -- The two figures the statement states about itself. Typed by a person from
  -- the statement, and together they are what the imported lines must carry
  -- opening to closing. NULL until entered: a period can be imported and
  -- matched before anyone reads the balances off the PDF.
  opening_balance  NUMERIC(14,2),
  closing_balance  NUMERIC(14,2),
  currency         TEXT NOT NULL DEFAULT 'INR',

  -- 'open'   — being worked on.
  -- 'closed' — every line accounted for and the balances agreed. Closing is a
  --            deliberate act and is what stops a period being re-imported.
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'closed')),

  notes            TEXT,
  imported_by      UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  closed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One statement per account per period. A second import of the same period
  -- is a mistake, not a new statement. Keyed on both ends rather than just the
  -- end date, because a bank will happily issue a month and a quarter that
  -- finish on the same day.
  UNIQUE (bank_account_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS bank_statements_account_idx
  ON public.bank_statements (bank_account_id, period_end DESC);

-- ── 3. The lines on it ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_statement_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id  UUID NOT NULL REFERENCES public.bank_statements(id) ON DELETE CASCADE,

  txn_date      DATE NOT NULL,
  description   TEXT NOT NULL,

  -- POSITIVE is money IN — a deposit, a receipt, interest credited.
  -- NEGATIVE is money OUT — a withdrawal, a payment, a charge.
  -- Signed rather than a debit/credit pair, so a period's movement is a plain
  -- SUM and the opening-to-closing check is one line of arithmetic.
  amount        NUMERIC(14,2) NOT NULL,

  -- The running balance the statement printed after this line, when it printed
  -- one. Kept because it is independent evidence: it settles the direction of
  -- an unmarked line at import, and afterwards it is the only way to find
  -- WHERE a period stopped adding up rather than merely that it did.
  balance_after NUMERIC(14,2),

  -- Cheque number, UTR, transaction id — whatever reference the bank carries.
  reference     TEXT,

  -- The source text this line was parsed from, kept verbatim. When a parse
  -- goes wrong the original is the only way to see how.
  raw           TEXT,

  -- 'ignored' is for a line that legitimately has no cash book entry: an
  -- internal transfer recorded from the other side, a charge already booked
  -- elsewhere. Ignoring is a decision, recorded with its reason, never a
  -- silent skip.
  status        TEXT NOT NULL DEFAULT 'unmatched'
                  CHECK (status IN ('unmatched', 'matched', 'ignored')),
  ignore_reason TEXT,

  display_order INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bank_statement_lines_statement_idx
  ON public.bank_statement_lines (statement_id, display_order);
CREATE INDEX IF NOT EXISTS bank_statement_lines_status_idx
  ON public.bank_statement_lines (statement_id, status);

-- ── 4. What each line was matched to ────────────────────────────────────────
-- MANY rows per line on purpose, the same as on a card: one bank debit is
-- often several cash book entries, because a single payment gets split so each
-- part can carry its own category and client.
CREATE TABLE IF NOT EXISTS public.bank_statement_matches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id            UUID NOT NULL REFERENCES public.bank_statement_lines(id) ON DELETE CASCADE,
  cashbook_entry_id  UUID NOT NULL REFERENCES public.cashbook_entries(id) ON DELETE CASCADE,

  -- 'auto'   — the matcher proposed it and a person accepted the batch.
  -- 'manual' — a person picked this entry for this line themselves.
  matched_by         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (matched_by IN ('auto', 'manual')),

  matched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_by_user    UUID REFERENCES public.employees(id) ON DELETE SET NULL,

  UNIQUE (line_id, cashbook_entry_id)
);

-- An entry belongs to ONE bank statement line. This is the rule that makes a
-- closed period mean something: without it one receipt could be counted
-- against two different statement lines and both would appear to balance.
--
-- Separate from the card index on purpose. An entry sits on exactly one
-- account, so it can only ever be claimed by one kind of statement — and
-- keeping the constraints apart means neither feature can lock rows out of
-- the other's table.
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_matches_entry_idx
  ON public.bank_statement_matches (cashbook_entry_id);

CREATE INDEX IF NOT EXISTS bank_statement_matches_line_idx
  ON public.bank_statement_matches (line_id);

COMMENT ON TABLE public.bank_statement_matches IS
  'Bank statement line to cashbook entry. Several entries per line is a normal case — one payment split so each part carries its own category.';

-- ── 5. RLS (house pattern: permissive; real authz is app-level guards) ──────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statements','bank_statement_lines','bank_statement_matches']
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
  ('bank_reconciliation', 'view',   'bank_reconciliation.view',   'View Bank Reconciliation',
    'Open a bank statement and see how it reconciles against the cash book',     91),
  ('bank_reconciliation', 'manage', 'bank_reconciliation.manage', 'Reconcile Bank Statements',
    'Import statements, match lines to entries, and close a statement period',   92)
ON CONFLICT (key) DO NOTHING;

COMMIT;
