-- Telling apart money that reached the account but is not the company's.
--
-- THE PROBLEM. A bank statement carries more than the company's trading. On a
-- personal or mixed-use account it also carries cashback, reward credits,
-- savings interest, fixed-deposit sweeps and the owner's own spending. None of
-- those are company funds, but every one of them lands in the same statement
-- and moves the same balance.
--
-- Before this, a line like that could only be IGNORED — status 'ignored' with
-- a free-text reason. That let a period close, but it threw the information
-- away: "how much cashback came in this period, so I can transfer it out"
-- had no answer short of reading the reasons and adding them up by hand.
--
-- THE MODEL. A line may carry a KIND alongside its status. The kind is a small
-- controlled vocabulary rather than free text, precisely so that lines can be
-- GROUPED and TOTALLED — which is the whole point. `ignore_reason` survives as
-- the optional note beside it, for the detail a kind cannot carry.
--
-- Whether a kind is the company's money is decided in the application
-- (src/lib/bank/line-kinds.ts), not here. That is a policy question — one
-- company treats card cashback as its own, another passes it to the account
-- holder — and policy that changes should not need a migration.

BEGIN;

ALTER TABLE public.bank_statement_lines
  ADD COLUMN IF NOT EXISTS line_kind TEXT
    CHECK (line_kind IS NULL OR line_kind IN (
      'cashback',   -- cashback and reward credits
      'interest',   -- savings or fixed-deposit interest
      'sweep',      -- auto-sweep in and out of a linked deposit; nets to zero
      'personal',   -- the account holder's own money, not the company's
      'elsewhere',  -- genuinely recorded, but against a different account
      'charge',     -- bank charges, fees and the tax on them
      'other'       -- anything else; the note carries the detail
    ));

COMMENT ON COLUMN public.bank_statement_lines.line_kind IS
  'Why this line has no cash book entry, as a groupable code. NULL for an ordinary line. Whether a kind counts as company funds is decided in src/lib/bank/line-kinds.ts, not by this constraint.';

-- Grouping and totalling by kind is the read this column exists for.
CREATE INDEX IF NOT EXISTS bank_statement_lines_kind_idx
  ON public.bank_statement_lines (statement_id, line_kind)
  WHERE line_kind IS NOT NULL;

COMMIT;
