-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Finance Foundation — Phase 3: journal views + company wallet             ║
-- ║                                                                            ║
-- ║  Requires 20260714090000_finance_scope_foundation (scope columns).        ║
-- ║                                                                            ║
-- ║  1. v_finance_journal / v_company_pnl_monthly — SQL read-model over the   ║
-- ║     cashbook for BI/integrity checks and the future GL feed. The app's    ║
-- ║     Finance Engine (src/lib/finance) queries base tables directly so it   ║
-- ║     keeps working even where these views aren't applied yet.              ║
-- ║  2. Company wallet — ad_wallet_ledger.client_id becomes nullable:         ║
-- ║     client_id NULL = Cirqle's own wallet, funding internal (company-      ║
-- ║     scoped) campaigns through the exact same credit/debit rails.          ║
-- ║  3. ad_reports.client_id nullable — internal campaigns can generate       ║
-- ║     reports (rendered with Cirqle branding).                              ║
-- ║  4. auto_attach_expense_to_invoice() becomes scope-aware: a company-      ║
-- ║     scoped outflow is NEVER rebilled onto a client invoice, even when it  ║
-- ║     carries a client_id for attribution.                                  ║
-- ║                                                                            ║
-- ║  Rollback: supabase/rollbacks/20260714093000_finance_views_company_wallet_down.sql ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── 1. Journal views ─────────────────────────────────────────────────────────
-- security_invoker: the view runs with the caller's privileges, so it never
-- widens access beyond the base tables' own RLS.

CREATE OR REPLACE VIEW public.v_finance_journal
WITH (security_invoker = true) AS
SELECT
  e.id,
  e.entry_date,
  e.scope,
  c.statement_section,
  c.account_code,
  e.category_id,
  c.name  AS category_name,
  e.client_id,
  e.employee_id,
  e.bank_account_id,
  CASE WHEN e.type = 'inflow' THEN e.amount_inr ELSE -e.amount_inr END AS amount_inr,
  e.description,
  e.is_reviewed,
  (e.transfer_ref IS NOT NULL) AS is_transfer
FROM public.cashbook_entries e
LEFT JOIN public.cashbook_categories c ON c.id = e.category_id
WHERE e.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.v_company_pnl_monthly
WITH (security_invoker = true) AS
SELECT
  date_trunc('month', entry_date)::date AS month,
  scope,
  statement_section,
  account_code,
  SUM(amount_inr) AS amount_inr,
  COUNT(*)        AS entry_count
FROM public.v_finance_journal
WHERE NOT is_transfer
GROUP BY 1, 2, 3, 4;

-- ── 2. Company wallet ────────────────────────────────────────────────────────
-- client_id NULL = the company's own wallet. The shape CHECK never referenced
-- client_id, so relaxing the NOT NULL is the entire schema change.

ALTER TABLE public.ad_wallet_ledger ALTER COLUMN client_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ad_wallet_ledger_company_idx
  ON public.ad_wallet_ledger (created_at DESC)
  WHERE deleted_at IS NULL AND client_id IS NULL;

-- ── 3. Internal campaign reports ─────────────────────────────────────────────

ALTER TABLE public.ad_reports ALTER COLUMN client_id DROP NOT NULL;

-- ── 4. Scope-aware expense rebilling ─────────────────────────────────────────
-- Same function as 20260701120000 with one new rule: scope='company' behaves
-- exactly like "not client-billable" — detaches any draft line, never attaches.
-- Reclassifying company→client (or tagging a client) counts as a
-- becoming-billable transition.

CREATE OR REPLACE FUNCTION auto_attach_expense_to_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_period      DATE;
  v_rate        NUMERIC(18,6);
  v_invoice_id  UUID;
  v_inv_currency TEXT;
  v_item_inv    UUID;
  v_item_status TEXT;
  v_should_add  BOOLEAN;
BEGIN
  -- ── Detach path: removed / soft-deleted / untagged / inflow / company books ─
  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR COALESCE(NEW.type, '') <> 'outflow'
     OR NEW.client_id IS NULL
     OR NEW.scope IS NOT DISTINCT FROM 'company'
  THEN
    SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
      FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.cashbook_entry_id = COALESCE(OLD.id, NEW.id)
     LIMIT 1;

    IF v_item_inv IS NOT NULL AND v_item_status IN ('draft', 'reviewed') THEN
      DELETE FROM invoice_expense_items WHERE cashbook_entry_id = COALESCE(OLD.id, NEW.id);
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;

    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Here: NEW is an active OUTFLOW tagged to a client on the client's books.

  -- Already billed? Propagate edits onto a draft/reviewed line (keep markup);
  -- leave sent/paid invoices untouched; never re-add elsewhere.
  SELECT ii.invoice_id, i.status INTO v_item_inv, v_item_status
    FROM invoice_expense_items ii JOIN invoices i ON i.id = ii.invoice_id
   WHERE ii.cashbook_entry_id = NEW.id
   LIMIT 1;

  IF v_item_inv IS NOT NULL THEN
    IF v_item_status IN ('draft', 'reviewed') THEN
      UPDATE invoice_expense_items
         SET description         = COALESCE(NULLIF(NEW.description, ''), description),
             original_amount     = NEW.amount,
             original_amount_inr = NEW.amount_inr,
             amount              = NEW.amount     + COALESCE(markup_amount, 0),
             amount_inr          = NEW.amount_inr + COALESCE(markup_amount, 0) * rate_to_inr_for(NEW.currency),
             currency            = COALESCE(NEW.currency, 'INR')
       WHERE cashbook_entry_id = NEW.id;
      PERFORM recalc_invoice_totals(v_item_inv);
    END IF;
    RETURN NEW;
  END IF;

  -- Not billed yet. Only auto-attach on INSERT or a becoming-billable
  -- transition, so a manual removal is respected (a plain edit won't re-add).
  v_should_add := (TG_OP = 'INSERT')
     OR (TG_OP = 'UPDATE' AND (
            (OLD.client_id IS NULL AND NEW.client_id IS NOT NULL)
         OR (COALESCE(OLD.type, '') <> 'outflow' AND NEW.type = 'outflow')
         OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
         OR (OLD.scope IS NOT DISTINCT FROM 'company' AND NEW.scope IS DISTINCT FROM 'company')
        ));

  IF NOT v_should_add THEN
    RETURN NEW;
  END IF;

  v_period     := DATE_TRUNC('month', COALESCE(NEW.entry_date, CURRENT_DATE))::DATE;
  v_rate       := rate_to_inr_for(NEW.currency);
  v_invoice_id := find_or_create_client_month_draft(NEW.client_id, v_period, NEW.currency, v_rate);

  -- Currency guard: only auto-attach when the draft's currency matches the entry
  -- (avoids introducing an FX conversion automatically — the badge surfaces the rest).
  SELECT COALESCE(currency, 'INR') INTO v_inv_currency FROM invoices WHERE id = v_invoice_id;
  IF v_inv_currency <> COALESCE(NEW.currency, 'INR') THEN
    RETURN NEW;
  END IF;

  INSERT INTO invoice_expense_items (
    invoice_id, cashbook_entry_id, description, amount, amount_inr, currency,
    original_amount, original_amount_inr, markup_type, markup_value, markup_amount
  ) VALUES (
    v_invoice_id, NEW.id, COALESCE(NULLIF(NEW.description, ''), 'Expense'),
    NEW.amount, NEW.amount_inr, COALESCE(NEW.currency, 'INR'),
    NEW.amount, NEW.amount_inr, 'none', 0, 0
  )
  ON CONFLICT (cashbook_entry_id) DO NOTHING;

  PERFORM recalc_invoice_totals(v_invoice_id);

  RETURN NEW;
END;
$$;

COMMIT;
