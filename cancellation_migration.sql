-- ═══════════════════════════════════════════════════════════════════════════
-- TASK CANCELLATION WITH LOSS TRACKING
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS cancelled_by        TEXT    CHECK (cancelled_by IN ('client', 'company', 'no_show')),
  ADD COLUMN IF NOT EXISTS cancellation_notes  TEXT,
  ADD COLUMN IF NOT EXISTS honor_contributions BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS loss_amount         DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_pct      INTEGER DEFAULT 0;

COMMENT ON COLUMN tasks.cancelled_by        IS 'Who triggered the cancellation: client | company | no_show';
COMMENT ON COLUMN tasks.cancellation_notes  IS 'Free-text reason / notes for the cancellation';
COMMENT ON COLUMN tasks.honor_contributions IS 'Whether employee contributions are kept and paid despite cancellation';
COMMENT ON COLUMN tasks.loss_amount         IS 'INR amount recorded as company loss (employee cost absorbed)';
COMMENT ON COLUMN tasks.completion_pct      IS 'Estimated % of work completed at time of cancellation (0-100)';
