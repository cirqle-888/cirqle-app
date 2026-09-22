-- Rollback for 20260922100000_bank_reconciliation.
--
-- DESTROYS every imported bank statement, every line and every match. The
-- cashbook entries themselves are untouched — they are ordinary entries that
-- happen to sit on a bank account, and nothing here owns them.
--
-- `reconcile_from` on bank_accounts is deliberately NOT dropped.
--
-- Either migration may have created it — both add it with IF NOT EXISTS — so
-- this rollback cannot know whether it is undoing its own column or removing
-- one the card feature is actively using, and a wrong guess silently discards
-- whatever dates were set on it. An unused DATE column costs nothing; losing
-- the reconciliation start dates costs a re-entry. Drop it by hand, after
-- checking no credit card account relies on it:
--
--   SELECT name, type, reconcile_from FROM public.bank_accounts
--    WHERE reconcile_from IS NOT NULL;

BEGIN;

DROP TABLE IF EXISTS public.bank_statement_matches;
DROP TABLE IF EXISTS public.bank_statement_lines;
DROP TABLE IF EXISTS public.bank_statements;

DELETE FROM public.permissions
 WHERE key IN ('bank_reconciliation.view', 'bank_reconciliation.manage');

COMMIT;
