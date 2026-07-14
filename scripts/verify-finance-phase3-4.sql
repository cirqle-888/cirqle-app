-- Post-apply verification for:
--   20260714093000_finance_views_company_wallet.sql   (Phase 3)
--   20260714095000_wallet_credit_rpc.sql              (Phase 4)
-- Run in the Supabase SQL editor after applying both.

-- 1. Views exist (expect 2 rows)
SELECT table_name FROM information_schema.views
 WHERE table_schema = 'public'
   AND table_name IN ('v_finance_journal', 'v_company_pnl_monthly')
 ORDER BY table_name;

-- 2. Journal view reconciles with the raw ledger (expect both totals equal)
SELECT
  (SELECT ROUND(SUM(amount_inr), 2) FROM v_finance_journal WHERE NOT is_transfer) AS journal_total,
  (SELECT ROUND(SUM(CASE WHEN type = 'inflow' THEN amount_inr ELSE -amount_inr END), 2)
     FROM cashbook_entries WHERE deleted_at IS NULL AND transfer_ref IS NULL)      AS ledger_total;

-- 3. Company wallet enabled (expect is_nullable = 'YES' for both rows)
SELECT table_name, column_name, is_nullable
  FROM information_schema.columns
 WHERE (table_name = 'ad_wallet_ledger' AND column_name = 'client_id')
    OR (table_name = 'ad_reports'       AND column_name = 'client_id');

-- 4. credit_ad_wallet RPC present (expect 1 row)
SELECT proname, pg_get_function_identity_arguments(oid) AS args
  FROM pg_proc
 WHERE proname = 'credit_ad_wallet';

-- 5. Ledger invariant: no funding entry is over-credited (expect 0 rows)
SELECT l.cashbook_entry_id,
       ROUND(SUM(l.amount), 2)        AS credited,
       ROUND(MAX(e.amount), 2)        AS entry_amount
  FROM ad_wallet_ledger l
  JOIN cashbook_entries e ON e.id = l.cashbook_entry_id
 WHERE l.direction = 'credit' AND l.deleted_at IS NULL
 GROUP BY l.cashbook_entry_id
HAVING SUM(l.amount) > MAX(e.amount) + 0.005;

-- 6. No wallet is negative (expect 0 rows; client_id NULL row = company wallet)
SELECT client_id,
       ROUND(SUM(CASE WHEN direction = 'credit' THEN amount_inr ELSE -amount_inr END), 2) AS balance
  FROM ad_wallet_ledger
 WHERE deleted_at IS NULL
 GROUP BY client_id
HAVING SUM(CASE WHEN direction = 'credit' THEN amount_inr ELSE -amount_inr END) < -0.005;

-- 7. Company campaigns never invoiced (expect 0 rows)
SELECT i.id, i.invoice_number, p.campaign_name
  FROM invoices i JOIN ad_projects p ON p.id = i.ad_project_id
 WHERE p.scope = 'company';

-- 8. Scope-aware rebilling: no company-scoped outflow sits on a client invoice
--    (expect 0 rows)
SELECT ii.id, e.description
  FROM invoice_expense_items ii
  JOIN cashbook_entries e ON e.id = ii.cashbook_entry_id
 WHERE e.scope = 'company';

-- 9. Performance sanity: the finance read path should use the scope index.
--    (expect a plan mentioning cashbook_entries_scope_idx once data volume
--    justifies it; on tiny tables a seq scan is normal and fine)
EXPLAIN (COSTS OFF)
SELECT * FROM cashbook_entries
 WHERE deleted_at IS NULL AND scope = 'company'
   AND entry_date >= CURRENT_DATE - INTERVAL '6 months';
