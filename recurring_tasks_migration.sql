-- Add recurring fields to tasks
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_interval TEXT CHECK (recurring_interval IN ('daily','weekly','biweekly','monthly')),
  ADD COLUMN IF NOT EXISTS recurring_end_date DATE,
  ADD COLUMN IF NOT EXISTS recurring_parent_id UUID REFERENCES tasks(id);

COMMENT ON COLUMN tasks.is_recurring IS 'If true, this task repeats on the given interval';
COMMENT ON COLUMN tasks.recurring_interval IS 'How often to repeat: daily, weekly, biweekly, monthly';
COMMENT ON COLUMN tasks.recurring_end_date IS 'Stop generating recurrences after this date (NULL = no end)';
COMMENT ON COLUMN tasks.recurring_parent_id IS 'For generated copies, points to the original task';
