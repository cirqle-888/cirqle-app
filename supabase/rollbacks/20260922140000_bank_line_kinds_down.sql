-- Rollback for 20260922140000_bank_line_kinds.
--
-- Dropping the column discards every classification made on every statement
-- line. The lines themselves, their matches and their 'ignored' status are
-- untouched — a line set aside as cashback stays set aside, it simply stops
-- saying WHY, so the per-kind totals go back to being unanswerable.

BEGIN;

DROP INDEX IF EXISTS public.bank_statement_lines_kind_idx;

ALTER TABLE public.bank_statement_lines
  DROP COLUMN IF EXISTS line_kind;

COMMIT;
