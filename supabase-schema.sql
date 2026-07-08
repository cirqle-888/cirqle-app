-- ============================================================
-- CIRQLE BUSINESS MANAGEMENT SYSTEM — Full Database Schema
-- Drop old tables, create fresh schema aligned with app code
-- ============================================================

-- Drop old tables (from creative-contribution-erp) if they exist
DROP TABLE IF EXISTS contribution_logs CASCADE;
DROP TABLE IF EXISTS contribution_snapshots CASCADE;
DROP TABLE IF EXISTS task_assignments CASCADE;
DROP TABLE IF EXISTS payout_entries CASCADE;
DROP TABLE IF EXISTS payout_cycles CASCADE;
DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS credit_notes CASCADE;
DROP TABLE IF EXISTS employee_weights CASCADE;
DROP TABLE IF EXISTS client_rates CASCADE;
DROP TABLE IF EXISTS memberships CASCADE;
DROP TABLE IF EXISTS organization_invites CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

-- Drop our own tables in reverse FK order
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS performance_metrics CASCADE;
DROP TABLE IF EXISTS deductions CASCADE;
DROP TABLE IF EXISTS credit_ledger CASCADE;
DROP TABLE IF EXISTS salary_advances CASCADE;
DROP TABLE IF EXISTS payroll CASCADE;
DROP TABLE IF EXISTS employee_performance_history CASCADE;
DROP TABLE IF EXISTS cashbook_entries CASCADE;
DROP TABLE IF EXISTS cashbook_categories CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS quotation_items CASCADE;
DROP TABLE IF EXISTS quotations CASCADE;
DROP TABLE IF EXISTS contribution_scores CASCADE;
DROP TABLE IF EXISTS contributions CASCADE;
DROP TABLE IF EXISTS task_tools CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS tool_services CASCADE;
DROP TABLE IF EXISTS tools CASCADE;
DROP TABLE IF EXISTS parameter_services CASCADE;
DROP TABLE IF EXISTS parameters CASCADE;
DROP TABLE IF EXISTS contribution_groups CASCADE;
DROP TABLE IF EXISTS client_service_pricing CASCADE;
DROP TABLE IF EXISTS services CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS bank_accounts CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS company_settings CASCADE;
DROP TABLE IF EXISTS exchange_rates CASCADE;

DROP VIEW IF EXISTS invoice_summary CASCADE;
DROP VIEW IF EXISTS monthly_cashbook_summary CASCADE;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- COMPANY SETTINGS
-- ============================================================
CREATE TABLE company_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO company_settings (key, value) VALUES
  ('company_name', 'Cirqle Design'),
  ('company_email', 'farooq@cirqle.work'),
  ('company_phone', '+91 81295 34377'),
  ('company_website', 'https://www.cirqle.work'),
  ('company_instagram', '@cirqle.design'),
  ('company_address', ''),
  ('company_gstin', ''),
  ('gst_enabled', 'false'),
  ('gst_rate', '18'),
  ('salary_reveal_day', '1'),
  ('salary_reveal_auto', 'true'),
  ('invoice_prefix', 'INV'),
  ('quotation_prefix', 'QUO'),
  ('default_currency', 'INR'),
  ('overdue_reminder_days', '7'),
  ('performance_calc_start_month', '2')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- EMPLOYEES
-- ============================================================
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_id UUID UNIQUE,
  cqid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'employee'
    CHECK (role IN ('super_admin', 'accounts', 'team_lead', 'employee', 'view_only')),
  performance_rating DECIMAL(5,2) DEFAULT 70,
  salary_type TEXT DEFAULT 'fixed'
    CHECK (salary_type IN ('fixed', 'commission_only', 'fixed_plus_commission', 'pure_commission', 'base_plus_commission', 'fixed_plus_bonus', 'hourly')),
  base_salary DECIMAL(10,2) DEFAULT 0,
  hourly_rate DECIMAL(10,2) DEFAULT 0,
  reveal_salary BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  joined_date DATE,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  bank_details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BANK ACCOUNTS
-- ============================================================
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT DEFAULT 'bank' CHECK (type IN ('bank', 'cash', 'wallet', 'other')),
  currency TEXT DEFAULT 'INR',
  account_number TEXT,
  bank_name TEXT,
  opening_balance DECIMAL(12,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX bank_accounts_one_default ON bank_accounts ((is_default)) WHERE is_default = true;

INSERT INTO bank_accounts (name, type, currency, opening_balance, display_order) VALUES
  ('Cash in Bank', 'bank', 'INR', 0, 1),
  ('Kotak', 'bank', 'INR', 0, 2);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  country TEXT DEFAULT 'India',
  gstin TEXT,
  default_currency TEXT DEFAULT 'INR',
  credit_limit DECIMAL(10,2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SERVICES
-- ============================================================
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  pricing_type TEXT NOT NULL DEFAULT 'fixed_per_creative'
    CHECK (pricing_type IN ('fixed_per_creative', 'percentage_of_spend', 'retainer', 'hourly')),
  retainer_cycle TEXT CHECK (retainer_cycle IN ('daily', 'weekly', 'monthly', 'yearly')),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT SERVICE PRICING
-- ============================================================
CREATE TABLE client_service_pricing (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  price DECIMAL(10,2),
  percentage_rate DECIMAL(5,2),
  commission_percentage DECIMAL(5,2) DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, service_id)
);

-- ============================================================
-- CONTRIBUTION GROUPS
-- ============================================================
CREATE TABLE contribution_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  weight DECIMAL(5,2) NOT NULL DEFAULT 50,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO contribution_groups (name, weight, display_order) VALUES
  ('Design Group', 50, 1),
  ('Variable Group', 50, 2);

-- ============================================================
-- PARAMETERS
-- ============================================================
CREATE TABLE parameters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID REFERENCES contribution_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  weight DECIMAL(5,2) DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PARAMETER <-> SERVICE LINKING
-- ============================================================
CREATE TABLE parameter_services (
  parameter_id UUID REFERENCES parameters(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (parameter_id, service_id)
);

-- ============================================================
-- TOOLS
-- ============================================================
CREATE TABLE tools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  group_id UUID REFERENCES contribution_groups(id),
  fixed_percentage DECIMAL(5,2) NOT NULL DEFAULT 10,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tools (name, fixed_percentage) VALUES ('Ideogram', 10);

-- ============================================================
-- TOOL <-> SERVICE LINKING
-- ============================================================
CREATE TABLE tool_services (
  tool_id UUID REFERENCES tools(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_id, service_id)
);

-- ============================================================
-- TASKS
-- ============================================================
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  client_id UUID REFERENCES clients(id),
  service_id UUID REFERENCES services(id),
  task_date DATE NOT NULL DEFAULT CURRENT_DATE,
  billing_amount DECIMAL(12,2) DEFAULT 0,
  billing_amount_inr DECIMAL(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'invoiced', 'cancelled')),
  contributions_locked BOOLEAN DEFAULT false,
  created_by UUID REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TASK TOOL USAGE
-- ============================================================
CREATE TABLE task_tools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  tool_id UUID REFERENCES tools(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, tool_id)
);

-- ============================================================
-- CONTRIBUTIONS (per employee per task per parameter)
-- ============================================================
CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id),
  parameter_id UUID REFERENCES parameters(id),
  value DECIMAL(10,2) DEFAULT 0,
  locked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, employee_id, parameter_id)
);

-- ============================================================
-- CONTRIBUTION SCORES (calculated results)
-- ============================================================
CREATE TABLE contribution_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id),
  score_percentage DECIMAL(8,4) DEFAULT 0,
  earnings_inr DECIMAL(12,2) DEFAULT 0,
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  previous_earnings DECIMAL(12,2),
  previous_performance_rating DECIMAL(5,2),
  recalculated_at TIMESTAMPTZ,
  recalculated_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  UNIQUE(task_id, employee_id)
);

-- ============================================================
-- QUOTATIONS
-- ============================================================
CREATE TABLE quotations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quotation_number TEXT UNIQUE NOT NULL,
  client_id UUID REFERENCES clients(id),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'approved', 'rejected', 'converted')),
  currency TEXT DEFAULT 'INR',
  total_amount DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  terms TEXT,
  created_by UUID REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE quotation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quotation_id UUID REFERENCES quotations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  service_id UUID REFERENCES services(id),
  quantity DECIMAL(10,2) DEFAULT 1,
  unit_price DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  display_order INTEGER DEFAULT 0
);

-- ============================================================
-- INVOICES
-- ============================================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number TEXT UNIQUE NOT NULL,
  client_id UUID REFERENCES clients(id),
  quotation_id UUID REFERENCES quotations(id),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled', 'bad_debt')),
  currency TEXT DEFAULT 'INR',
  total_amount DECIMAL(12,2) DEFAULT 0,
  paid_amount DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  created_by UUID REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id),
  description TEXT NOT NULL,
  service_id UUID REFERENCES services(id),
  quantity DECIMAL(10,2) DEFAULT 1,
  unit_price DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  display_order INTEGER DEFAULT 0
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT DEFAULT 'bank_transfer'
    CHECK (payment_method IN ('bank_transfer', 'cash', 'upi', 'cheque', 'online', 'other')),
  bank_account_id UUID REFERENCES bank_accounts(id),
  reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CASH BOOK CATEGORIES
-- ============================================================
CREATE TABLE cashbook_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('inflow', 'outflow', 'both')),
  category_group TEXT,
  has_billable_flag BOOLEAN DEFAULT false,
  has_client_link BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO cashbook_categories (name, type, category_group, has_client_link, display_order) VALUES
  ('Invoice', 'inflow', 'Revenue', true, 1),
  ('Visiting Charge', 'inflow', 'Revenue', true, 2),
  ('Commission', 'inflow', 'Revenue', true, 3),
  ('Cost Recovery', 'inflow', 'Revenue', true, 4),
  ('Credit Return', 'inflow', 'Financial', true, 5),
  ('Other Income', 'inflow', 'Other', false, 6),
  ('Salary', 'outflow', 'Operational', false, 1),
  ('Rent & Workspace', 'outflow', 'Operational', false, 2),
  ('Communication & Utilities', 'outflow', 'Operational', false, 3),
  ('Online Spend', 'outflow', 'Business Costs', true, 4),
  ('Software & Subscriptions', 'outflow', 'Business Costs', false, 5),
  ('Printing & Stationery', 'outflow', 'Business Costs', false, 6),
  ('Equipment & Devices', 'outflow', 'Business Costs', false, 7),
  ('Office & Furniture', 'outflow', 'Business Costs', false, 8),
  ('Business Purchases', 'outflow', 'Business Costs', false, 9),
  ('Travel & Commute', 'outflow', 'People & Travel', false, 10),
  ('Food & Entertainment', 'outflow', 'People & Travel', false, 11),
  ('Bank Fees & Surcharges', 'outflow', 'Financial', false, 12),
  ('Personal Withdrawals', 'outflow', 'Financial', false, 13),
  ('Tax & Government Fees', 'outflow', 'Financial', false, 14),
  ('Professional Services', 'outflow', 'Financial', false, 15),
  ('Credit Given', 'outflow', 'Financial', false, 16),
  ('Marketing & Promotions', 'outflow', 'Marketing', false, 17);

UPDATE cashbook_categories SET has_billable_flag = true WHERE name = 'Online Spend';

-- ============================================================
-- CASH BOOK ENTRIES
-- ============================================================
CREATE TABLE cashbook_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  bank_account_id UUID REFERENCES bank_accounts(id),
  type TEXT NOT NULL CHECK (type IN ('inflow', 'outflow')),
  category_id UUID REFERENCES cashbook_categories(id),
  is_billable BOOLEAN DEFAULT false,
  client_id UUID REFERENCES clients(id),
  service_id UUID REFERENCES services(id),
  employee_id UUID REFERENCES employees(id),
  invoice_id UUID REFERENCES invoices(id),
  amount DECIMAL(12,2) NOT NULL,
  currency TEXT DEFAULT 'INR',
  amount_inr DECIMAL(12,2) NOT NULL,
  payment_method TEXT,
  reference TEXT,
  notes TEXT,
  created_by UUID REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PAYROLL
-- ============================================================
CREATE TABLE payroll (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id),
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  base_salary DECIMAL(12,2) DEFAULT 0,
  commission_earned DECIMAL(12,2) DEFAULT 0,
  bonus DECIMAL(12,2) DEFAULT 0,
  advances_deducted DECIMAL(12,2) DEFAULT 0,
  other_deductions DECIMAL(12,2) DEFAULT 0,
  net_salary DECIMAL(12,2) DEFAULT 0,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'revealed', 'paid', 'partial')),
  paid_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, month, year)
);

-- ============================================================
-- SALARY ADVANCES
-- ============================================================
CREATE TABLE salary_advances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id),
  amount DECIMAL(10,2) NOT NULL,
  advance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT,
  repayment_type TEXT DEFAULT 'deduct_from_salary'
    CHECK (repayment_type IN ('deduct_from_salary', 'one_time', 'installment')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'repaid')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CREDIT LEDGER
-- ============================================================
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type TEXT NOT NULL DEFAULT 'employee'
    CHECK (entity_type IN ('employee', 'owner', 'other')),
  entity_id UUID REFERENCES employees(id),
  credit_type TEXT NOT NULL CHECK (credit_type IN ('given', 'returned')),
  amount DECIMAL(10,2) NOT NULL,
  credit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  bank_account_id UUID REFERENCES bank_accounts(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DEDUCTIONS
-- ============================================================
CREATE TABLE deductions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id),
  type TEXT NOT NULL CHECK (type IN ('discount', 'bad_debt', 'other')),
  amount DECIMAL(10,2) NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PERFORMANCE METRICS (monthly snapshot)
-- ============================================================
CREATE TABLE performance_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id),
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  avg_score DECIMAL(8,4) DEFAULT 0,
  quality_100 INTEGER DEFAULT 0,
  quality_76_99 INTEGER DEFAULT 0,
  quality_51_75 INTEGER DEFAULT 0,
  quality_26_50 INTEGER DEFAULT 0,
  quality_0_25 INTEGER DEFAULT 0,
  total_tasks INTEGER DEFAULT 0,
  total_creatives INTEGER DEFAULT 0,
  active_days INTEGER DEFAULT 0,
  suggested_rating DECIMAL(5,2),
  suggestion_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, month, year)
);

-- ============================================================
-- EXCHANGE RATES
-- ============================================================
CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency TEXT UNIQUE NOT NULL,
  rate_to_inr DECIMAL(12,6) NOT NULL,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO exchange_rates (currency, rate_to_inr) VALUES
  ('AED', 22.89),
  ('SAR', 22.51),
  ('USD', 84.50),
  ('QAR', 23.21),
  ('GBP', 107.50),
  ('EUR', 91.20)
ON CONFLICT (currency) DO NOTHING;

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  read BOOLEAN DEFAULT false,
  link TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id),
  action TEXT NOT NULL,
  table_name TEXT,
  record_id UUID,
  old_value JSONB,
  new_value JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VIEWS
-- ============================================================
CREATE VIEW invoice_summary AS
SELECT
  c.name AS client_name,
  c.code AS client_code,
  COUNT(i.id) AS total_invoices,
  SUM(i.total_amount) AS total_billed,
  SUM(i.paid_amount) AS total_received,
  SUM(i.total_amount - i.paid_amount) AS total_outstanding
FROM invoices i
JOIN clients c ON i.client_id = c.id
WHERE i.status NOT IN ('cancelled')
GROUP BY c.id, c.name, c.code;

CREATE VIEW monthly_cashbook_summary AS
SELECT
  EXTRACT(YEAR FROM entry_date)::INTEGER AS year,
  EXTRACT(MONTH FROM entry_date)::INTEGER AS month,
  SUM(CASE WHEN type = 'inflow' THEN amount_inr ELSE 0 END) AS total_inflow,
  SUM(CASE WHEN type = 'outflow' THEN amount_inr ELSE 0 END) AS total_outflow,
  SUM(CASE WHEN type = 'inflow' THEN amount_inr ELSE -amount_inr END) AS net
FROM cashbook_entries
GROUP BY year, month
ORDER BY year, month;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribution_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Allow all for now (tighten with auth later)
CREATE POLICY "allow_all" ON employees FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON contributions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON contribution_scores FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON payroll FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON performance_metrics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON notifications FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER quotations_updated_at BEFORE UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER payroll_updated_at BEFORE UPDATE ON payroll FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER cashbook_updated_at BEFORE UPDATE ON cashbook_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
