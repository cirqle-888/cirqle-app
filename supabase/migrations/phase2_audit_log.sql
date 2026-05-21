-- ============================================================
-- PHASE 2: CASHBOOK AUDIT LOG TABLE
-- Creates the audit trail table that Phase 1's trigger already
-- tries to insert into (with a safe EXCEPTION fallback).
-- After this runs, audit rows will populate automatically.
-- ============================================================

CREATE TABLE IF NOT EXISTS cashbook_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id        UUID REFERENCES cashbook_entries(id) ON DELETE SET NULL,
    invoice_id      UUID REFERENCES invoices(id)         ON DELETE SET NULL,
    operation       TEXT        NOT NULL,   -- INSERT | UPDATE | DELETE | SOFT_DELETE | RECONCILE
    changed_by      UUID,                   -- auth.uid() captured on frontend-level inserts (optional)
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    old_amount      NUMERIC,               -- cashbook entry amount before change
    new_amount      NUMERIC,               -- cashbook entry amount after change
    old_paid_amount NUMERIC,               -- invoice paid_amount before trigger ran
    new_paid_amount NUMERIC,               -- invoice paid_amount after trigger ran
    old_status      TEXT,                  -- invoice status before
    new_status      TEXT,                  -- invoice status after
    notes           TEXT                   -- free-form operator notes (e.g. reconciliation reason)
);

-- Indexes for fast reverse-lookups
CREATE INDEX IF NOT EXISTS idx_audit_entry_id   ON cashbook_audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_audit_invoice_id ON cashbook_audit_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON cashbook_audit_log(changed_at DESC);

-- Enable Row Level Security (read-only for authenticated users, full for service role)
ALTER TABLE cashbook_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_read_authenticated"
  ON cashbook_audit_log
  FOR SELECT
  TO authenticated
  USING (true);

-- Service role can do everything (used by SECURITY DEFINER trigger)
-- No INSERT policy needed for authenticated users — only the trigger inserts.

-- Backfill: Insert a RECONCILE event for every currently linked cashbook entry
-- so the audit log has historical starting context.
INSERT INTO cashbook_audit_log (entry_id, invoice_id, operation, new_amount, new_paid_amount, new_status, notes)
SELECT
    ce.id,
    ce.invoice_id,
    'RECONCILE',
    ce.amount,
    i.paid_amount,
    i.status,
    'Historical backfill on audit log creation'
FROM cashbook_entries ce
JOIN invoices i ON i.id = ce.invoice_id
WHERE ce.invoice_id IS NOT NULL
  AND ce.deleted_at IS NULL
ON CONFLICT DO NOTHING;
