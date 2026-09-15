-- Rollback for 20260915100000_card_reconciliation.
--
-- DESTROYS every imported statement, every line and every match. The cashbook
-- entries themselves are untouched — they are ordinary entries that happen to
-- sit on a card account, and nothing here owns them.
--
-- The columns on bank_accounts are dropped last and separately: if a card
-- account has been created and used, dropping `statement_day` leaves it as an
-- account of type 'credit_card' with no cycle, which the UI reads as
-- unconfigured rather than broken. No entry is lost either way.

BEGIN;

DROP TABLE IF EXISTS public.card_statement_matches;
DROP TABLE IF EXISTS public.card_statement_lines;
DROP TABLE IF EXISTS public.card_statements;

ALTER TABLE public.bank_accounts
  DROP COLUMN IF EXISTS statement_day,
  DROP COLUMN IF EXISTS due_day,
  DROP COLUMN IF EXISTS credit_limit,
  DROP COLUMN IF EXISTS card_last4,
  DROP COLUMN IF EXISTS reconcile_from;

-- Accounts created as cards become plain accounts again rather than an
-- unknown type the settings form cannot render.
UPDATE public.bank_accounts SET type = 'other' WHERE type = 'credit_card';

DELETE FROM public.permissions
 WHERE key IN ('card_reconciliation.view', 'card_reconciliation.manage');

COMMIT;
