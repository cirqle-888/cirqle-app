-- Payslip email delivery history.
-- Every payslip send (single or bulk) writes one row here so the app can show
-- who was emailed, when, by whom, and the exact figures that went out.

CREATE TABLE IF NOT EXISTS public.payslip_emails (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  month        smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  year         smallint NOT NULL,
  sent_to      text NOT NULL,                 -- the email address it was sent to
  subject      text NOT NULL,
  status       text NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed'
  resend_id    text,                          -- Resend message id (for tracing)
  error        text,                          -- failure reason when status = 'failed'
  snapshot     jsonb,                         -- the PayslipData that was rendered
  sent_by      uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  sent_at      timestamptz NOT NULL DEFAULT now()
);

-- Lookups are always by employee + period, or "history for this month".
CREATE INDEX IF NOT EXISTS payslip_emails_emp_period_idx
  ON public.payslip_emails (employee_id, year, month);
CREATE INDEX IF NOT EXISTS payslip_emails_period_idx
  ON public.payslip_emails (year, month);
CREATE INDEX IF NOT EXISTS payslip_emails_sent_at_idx
  ON public.payslip_emails (sent_at DESC);

COMMENT ON TABLE public.payslip_emails IS
  'Audit trail of payslip emails sent to employees (single + bulk). snapshot holds the rendered figures.';
