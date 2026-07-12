-- Create employee_performance_history table
CREATE TABLE IF NOT EXISTS employee_performance_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  performance_rating DECIMAL(5,2) NOT NULL,
  effective_from DATE NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add audit fields to contribution_scores for historical recalculations
ALTER TABLE contribution_scores
ADD COLUMN IF NOT EXISTS previous_earnings DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS previous_performance_rating DECIMAL(5,2),
ADD COLUMN IF NOT EXISTS recalculated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS recalculated_by UUID REFERENCES employees(id) ON DELETE SET NULL;

-- Enable RLS on employee_performance_history
ALTER TABLE employee_performance_history ENABLE ROW LEVEL SECURITY;

-- Create policies for employee_performance_history
CREATE POLICY "Super admins and accounts can manage performance history"
  ON employee_performance_history FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM employees
      WHERE employees.auth_id = auth.uid()
      AND employees.role IN ('super_admin', 'accounts')
    )
  );

CREATE POLICY "Users can view their own performance history"
  ON employee_performance_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM employees
      WHERE employees.auth_id = auth.uid()
      AND employees.id = employee_performance_history.employee_id
    )
  );
