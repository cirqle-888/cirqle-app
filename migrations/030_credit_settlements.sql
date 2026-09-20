-- ───────────────────────────────────────────────────────────────────────────
-- Credit given can end three ways, not one.
--
-- Today credit_ledger.credit_type allows 'given' and 'returned', so the only
-- recorded ending is the money coming back. Two others happen constantly and
-- had nowhere to go:
--
--   converted_drawings  the money is not coming back and never was. It is
--                       the owner taking their share. Stays out of P&L —
--                       a drawing is not an expense — so this changes who
--                       is owed, not what anything cost.
--
--   converted_salary    an employee's advance becomes pay. This one DOES
--                       change P&L: the business has now spent the money on
--                       salary, where before it held a receivable. Without
--                       this, somebody is paid and it never appears as a cost.
--
-- Both may be partial. A ₹50,000 credit can return ₹20,000 in cash, convert
-- ₹20,000 to salary and leave ₹10,000 outstanding — which is why these are
-- rows against the person rather than a status on the original.
--
-- Outstanding is then: given − returned − converted_drawings − converted_salary.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE credit_ledger
  DROP CONSTRAINT IF EXISTS credit_ledger_credit_type_check;

ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_credit_type_check
  CHECK (credit_type IN ('given', 'returned', 'converted_drawings', 'converted_salary'));

-- What the row settles, when it is a settlement. Null for a 'given'.
-- Not a foreign key to a single 'given' row on purpose: a settlement can
-- cover several credits at once, and forcing a one-to-one here would mean
-- splitting a ₹30,000 repayment into three rows nobody asked for. The
-- balance is per person, and that is the level it is reconciled at.
ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS settles_note text;

COMMENT ON COLUMN credit_ledger.credit_type IS
  'given | returned | converted_drawings | converted_salary. Outstanding per person = given minus the other three.';
