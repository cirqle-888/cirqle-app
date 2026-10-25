-- Rollback for 20261016110000_cashbook_reversals_drop_release_fks.
--
-- Do NOT run this on its own: re-adding these foreign keys makes every
-- PostgREST embed between cashbook_entries and the allocation tables
-- ambiguous (PGRST201), which breaks the Cash Book. It exists only for
-- symmetry; to undo the reversal feature, run
-- 20261016100000_cashbook_reversals_down.sql, which drops the columns.

SELECT 1;
