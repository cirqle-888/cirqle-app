-- ============================================================
-- Invoice Follow-ups (Collections tracker)
-- ============================================================
-- Per-invoice collections log: who chased the client, what the client said,
-- the date the client PROMISED to pay, and when to chase again. Powers the
-- /dashboard/invoices/follow-ups page (Needs to be sent / Urgent / Regular)
-- and the dashboard follow-up widget.
--
-- The "current state" of an invoice's follow-up = its latest row by created_at.
-- Urgency (Urgent vs Regular) is derived in the app from promised_date /
-- next_followup_date / overdue status — this table only stores the facts.
--
-- No RLS: the app reads/writes via the service-role admin client and gates
-- every call with app-layer permission checks (billing.edit / billing.view_workflow),
-- consistent with activity_logs (010) and the request portal. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS invoice_followups (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- What the client said / what was done on this contact
  note               text,
  -- Outcome of the contact (drives the badge + colour in the UI)
  outcome            text        CHECK (outcome IN (
                                   'promised', 'no_response', 'disputed',
                                   'partial_promised', 'callback', 'sent', 'other'
                                 )),
  -- The date the client COMMITTED to transfer. When reached/passed and still
  -- unpaid, the invoice auto-escalates to "Urgent" (and shows "Promise missed").
  promised_date      date,
  -- When we said we'd follow up again. When reached/passed → "Urgent".
  next_followup_date date,
  -- Who logged this follow-up
  created_by         uuid        REFERENCES employees(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- "latest follow-up per invoice" + "all follow-ups for invoice X" both covered.
CREATE INDEX IF NOT EXISTS idx_invoice_followups_invoice
  ON invoice_followups (invoice_id, created_at DESC);

COMMENT ON TABLE invoice_followups IS
  'Collections follow-up log per invoice. Latest row = current state. '
  'Urgency is derived in-app from promised_date / next_followup_date / overdue.';
