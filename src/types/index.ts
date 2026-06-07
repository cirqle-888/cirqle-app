export type Role = 'super_admin' | 'accounts' | 'team_lead' | 'employee' | 'view_only'
export type SalaryType = 'pure_commission' | 'fixed' | 'base_plus_commission' | 'fixed_plus_bonus' | 'hourly'
export type PricingType = 'fixed_per_creative' | 'percentage_of_spend' | 'retainer' | 'hourly'
export type RetainerCycle = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type TaskStatus = 'pending' | 'done' | 'invoiced' | 'paid'
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'cancelled' | 'bad_debt'
export type QuotationStatus = 'draft' | 'sent' | 'approved' | 'rejected' | 'converted'
export type PaymentMethod = 'bank_transfer' | 'cash' | 'upi' | 'cheque' | 'other'
export type CashbookType = 'income' | 'expense' | 'transfer'
export type Currency = 'INR' | 'AED' | 'SAR' | 'USD' | 'QAR' | 'GBP' | 'EUR'

export interface Employee {
  id: string
  auth_id?: string
  cqid: string
  name: string
  email: string
  role: Role
  performance_rating: number
  salary_type: SalaryType
  base_salary: number
  hourly_rate: number
  is_active: boolean
  joined_date?: string
  created_at: string
  updated_at: string
}

export interface Client {
  id: string
  code: string
  name: string
  contact_name?: string
  phone?: string
  email?: string
  address?: string
  gstin?: string
  credit_limit: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Service {
  id: string
  name: string
  pricing_type: PricingType
  retainer_cycle?: RetainerCycle
  description?: string
  is_active: boolean
  display_order: number
  created_at: string
  updated_at: string
}

export interface ClientServicePricing {
  id: string
  client_id: string
  service_id: string
  price?: number
  percentage_rate?: number
  commission_percentage: number
  currency: Currency
  is_active: boolean
  client?: Client
  service?: Service
}

export interface ContributionGroup {
  id: string
  name: string
  weight: number
  is_active: boolean
  display_order: number
  parameters?: Parameter[]
}

export interface Parameter {
  id: string
  group_id: string
  name: string
  weight: number
  is_master?: boolean   // true = master param (gets % score 0-100), false = sub-param (gets count)
  is_active: boolean
  display_order: number
  group?: ContributionGroup
}

export interface Tool {
  id: string
  name: string
  group_id?: string
  fixed_percentage: number
  is_active: boolean
  group?: ContributionGroup
}

export interface Task {
  id: string
  sl_no: number
  date: string
  client_id: string
  service_id: string
  reference?: string
  no_of_creatives: number
  pricing_type?: string
  spend_amount?: number
  hours?: number
  billing_amount_original?: string
  currency: Currency
  billing_amount_inr?: number
  status: TaskStatus
  contributions_locked: boolean
  created_by?: string
  created_at: string
  updated_at: string
  client?: Client
  service?: Service
}

export interface Contribution {
  id: string
  task_id: string
  employee_id: string
  parameter_id: string
  value: number
  locked: boolean
  created_at: string
  updated_at: string
  parameter?: Parameter
  employee?: Employee
}

export interface EmployeePerformanceHistory {
  id: string
  employee_id: string
  performance_rating: number
  effective_from: string
  reason?: string
  created_at: string
  updated_at: string
  employee?: Employee
}

export interface ContributionScore {
  id: string
  task_id: string
  employee_id: string
  score_percentage: number
  earnings: number
  calculated_at: string
  previous_earnings?: number
  previous_performance_rating?: number
  recalculated_at?: string
  recalculated_by?: string
  employee?: Employee
}

export interface Invoice {
  id: string
  invoice_number: string
  client_id: string
  quotation_id?: string
  date: string
  due_date?: string
  status: InvoiceStatus
  subtotal: number
  discount: number
  gst_amount: number
  total: number
  amount_received: number
  balance_due: number
  notes?: string
  created_by?: string
  created_at: string
  updated_at: string
  client?: Client
  items?: InvoiceItem[]
  payments?: Payment[]
}

export interface InvoiceItem {
  id: string
  invoice_id: string
  task_id?: string
  description: string
  service_id?: string
  quantity: number
  unit_price: number
  amount: number
  display_order: number
  service?: Service
}

export interface Payment {
  id: string
  invoice_id: string
  amount: number
  date: string
  method: PaymentMethod
  bank_account_id?: string
  reference?: string
  notes?: string
  created_at: string
  bank_account?: BankAccount
}

export interface Quotation {
  id: string
  quotation_number: string
  client_id: string
  date: string
  valid_until?: string
  status: QuotationStatus
  subtotal: number
  discount: number
  gst_amount: number
  total: number
  notes?: string
  converted_invoice_id?: string
  created_by?: string
  created_at: string
  updated_at: string
  client?: Client
  items?: QuotationItem[]
}

export interface QuotationItem {
  id: string
  quotation_id: string
  description: string
  service_id?: string
  quantity: number
  unit_price: number
  amount: number
  display_order: number
}

export interface BankAccount {
  id: string
  name: string
  opening_balance: number
  is_active: boolean
  display_order: number
  created_at: string
}

export interface CashbookCategory {
  id: string
  name: string
  type: CashbookType
  category_group?: string
  has_billable_flag: boolean
  has_client_link: boolean
  is_active: boolean
  display_order: number
}

export interface CashbookEntry {
  id: string
  date: string
  description: string
  bank_account_id?: string
  type: CashbookType
  category_id?: string
  is_billable: boolean
  client_id?: string
  service_id?: string
  employee_id?: string
  invoice_id?: string
  amount: number
  payment_method?: string
  reference?: string
  notes?: string
  transfer_to_account_id?: string
  created_by?: string
  created_at: string
  bank_account?: BankAccount
  category?: CashbookCategory
  client?: Client
  employee?: Employee
  invoice?: Invoice
}

export interface Payroll {
  id: string
  employee_id: string
  month: number
  year: number
  commission_earned: number
  base_salary: number
  bonus: number
  advance_deduction: number
  credit_deduction: number
  total_payable: number
  total_paid: number
  balance_owed: number
  status: 'pending' | 'revealed' | 'paid' | 'partial'
  reveal_date?: string
  created_at: string
  employee?: Employee
}

export interface CreditLedgerEntry {
  id: string
  employee_id: string
  type: 'given' | 'return'
  amount: number
  date: string
  bank_account_id?: string
  notes?: string
  created_at: string
  employee?: Employee
}

export interface PerformanceMetric {
  id: string
  employee_id: string
  month: number
  year: number
  avg_score: number
  quality_100: number
  quality_76_99: number
  quality_51_75: number
  quality_26_50: number
  quality_0_25: number
  total_tasks: number
  total_creatives: number
  active_days: number
  suggested_rating?: number
  suggestion_reason?: string
  created_at: string
  employee?: Employee
}

export interface ExchangeRate {
  id: string
  currency: Currency
  rate_to_inr: number
  last_updated: string
  /** Where the current rate came from: a successful API sync or a manual edit. */
  rate_source?: 'api' | 'manual'
  /** Value date of the rate (the API's published date, or the manual edit date). */
  rate_date?: string
}

export interface Notification {
  id: string
  employee_id: string
  type: string
  title: string
  message?: string
  read: boolean
  link?: string
  created_at: string
}

export interface AuditLog {
  id: string
  employee_id?: string
  action: string
  table_name?: string
  record_id?: string
  old_value?: Record<string, unknown>
  new_value?: Record<string, unknown>
  ip_address?: string
  created_at: string
  employee?: Employee
}

export interface CompanySetting {
  id: string
  key: string
  value: string
  updated_at: string
}

// Dashboard summary types
export interface DashboardSummary {
  totalIncome: number
  totalExpenses: number
  netProfit: number
  bankBalance: number
  expectedCash: number
  overdueAmount: number
  outstandingAmount: number
  jobsThisMonth: number
  creativesThisMonth: number
}

export interface MonthlyBreakdown {
  month: number
  year: number
  label: string
  income: number
  expense: number
  revenue: number
  balance: number
  jobs: number
}
