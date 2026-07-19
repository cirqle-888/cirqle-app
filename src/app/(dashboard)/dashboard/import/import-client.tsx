'use client'

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast, ToastContainer } from '@/components/ui/toast'

// ─── Types ────────────────────────────────────────────────────────────────────
interface RefClient    { id: string; name: string; code: string }
interface RefService   { id: string; name: string }
interface RefEmployee  { id: string; cqid: string; name: string }
interface RefGroup     { id: string; name: string; weight: number }
interface RefParameter { id: string; name: string; group_id: string; weight: number; display_order: number }

interface RefBankAccount  { id: string; name: string }
interface RefCashCategory { id: string; name: string; type: string }

interface Props {
  clients:         RefClient[]
  services:        RefService[]
  employees:       RefEmployee[]
  groups:          RefGroup[]
  parameters:      RefParameter[]
  bankAccounts:    RefBankAccount[]
  cashCategories:  RefCashCategory[]
}

export type ContribSubMode = 'earnings_only' | 'score_pct' | 'param_detail'

export type ImportMode =
  | 'employees'
  | 'clients'
  | 'services'
  | 'groups'
  | 'parameters'
  | 'tools'
  | 'pricing_matrix'
  | 'jobs'
  | 'contributions'
  | 'cashbook_entries'
  | 'invoices'
  | 'invoice_status'
  | 'discounts'

interface ParsedRow {
  _line:    number
  errors:   string[]
  warnings: string[]
  status:   'ok' | 'warn' | 'error'
  [key: string]: any
}

// ─── Mode metadata ────────────────────────────────────────────────────────────
// Flat list kept for backward compatibility (cleanup tab, TABLE_FOR_MODE, etc.)
const MODES: { key: ImportMode; label: string; emoji: string }[] = [
  { key: 'employees',      label: 'Employees',           emoji: '👤' },
  { key: 'clients',        label: 'Clients',             emoji: '🏢' },
  { key: 'services',       label: 'Services',            emoji: '⚙️' },
  { key: 'groups',         label: 'Contribution Groups', emoji: '🗂️' },
  { key: 'parameters',     label: 'Parameters',          emoji: '📊' },
  { key: 'tools',          label: 'Tools',               emoji: '🔧' },
  { key: 'pricing_matrix', label: 'Pricing Matrix',      emoji: '💰' },
  { key: 'jobs',           label: 'Jobs (Tasks)',         emoji: '✅' },
  { key: 'cashbook_entries', label: 'Cashbook Entries',  emoji: '📒' },
  { key: 'contributions',  label: 'Contributions',       emoji: '📈' },
  { key: 'invoices',       label: 'Invoices',            emoji: '🧾' },
  { key: 'invoice_status', label: 'Invoice Status Update', emoji: '🔄' },
  { key: 'discounts',      label: 'Discount History',    emoji: '🎁' },
]

// Tiered grouping — shown in the import UI to guide the user on order
const IMPORT_TIERS: { tier: number; label: string; color: string; hint: string; modes: ImportMode[] }[] = [
  {
    tier: 1,
    label: 'Foundation',
    color: 'emerald',
    hint: 'No dependencies — import these first',
    modes: ['employees', 'clients', 'services', 'groups', 'parameters', 'tools'],
  },
  {
    tier: 2,
    label: 'Pricing',
    color: 'blue',
    hint: 'Needs Clients + Services to exist first',
    modes: ['pricing_matrix'],
  },
  {
    tier: 3,
    label: 'Operations',
    color: 'amber',
    hint: 'Needs Clients + Services. Tasks must exist before cashbook entries that reference them',
    modes: ['jobs', 'cashbook_entries'],
  },
  {
    tier: 4,
    label: 'Financial Records',
    color: 'violet',
    hint: 'Needs Jobs/Tasks + Employees to exist first',
    modes: ['contributions', 'invoices', 'invoice_status', 'discounts'],
  },
]

// ─── Templates ───────────────────────────────────────────────────────────────
// `id` is the first column in every template — leave blank for new inserts,
// required for Update mode. Use the "Export current data" button to get a CSV
// with real `id` values already filled in, then modify and re-import.
const TEMPLATES: Record<ImportMode, { header: string; example: string }> = {
  employees: {
    header: 'id,cqid,name,email,phone,role,salary_type,base_salary,performance_rating,joined_date,is_active',
    example: [
      '"","CQ001","John Smith","john@cirqle.in","9876543210","employee","fixed","25000","80","2024-01-15","true"',
      '"","CQ002","Jane Doe","jane@cirqle.in","9876543211","team_lead","fixed_plus_commission","30000","85","2024-03-01","true"',
    ].join('\n'),
  },
  clients: {
    header: 'id,code,name,contact_name,phone,email,address,gstin,default_currency,billing_cycle,billing_day,is_active',
    example: [
      '"","SSM001","Sea Star Supermarket","Ravi Kumar","9876540001","ravi@seastar.in","MG Road, Kochi","","INR","monthly","1","true"',
      '"","BNM001","B.N. Mart Supermarket","Anita Nair","9876540002","","Anna Nagar, Chennai","","INR","monthly","1","true"',
    ].join('\n'),
  },
  services: {
    header: 'id,name,pricing_type,description,display_order,default_price,default_currency,group_names,is_active',
    example: [
      '"","Offer Flyer","fixed_per_creative","Promotional offer flyer design","1","","INR","Design Group | Variable Group","true"',
      '"","Social Media Management","retainer","Monthly social media package","2","","INR","Design Group","true"',
      '"","Paid Ads","percentage_of_spend","Google/Meta ad management","3","","INR","","true"',
    ].join('\n'),
  },
  groups: {
    header: 'id,name,weight,description,display_order,is_active',
    example: [
      '"","Design Group","50","Core design work parameters","1","true"',
      '"","Variable Group","50","Variable/product update parameters","2","true"',
    ].join('\n'),
  },
  parameters: {
    header: 'id,group_name,name,is_master,weight,description,display_order,input_type,is_active',
    example: [
      '"","Design Group","Design","TRUE","1","Main design score (0-100%)","1","percentage","true"',
      '"","Design Group","Date Change","FALSE","0.04","Date update on existing design","2","count","true"',
      '"","Design Group","Title Change","FALSE","0.16","Title/heading change","3","count","true"',
      '"","Design Group","Color Change","FALSE","0.12","Color scheme change","4","count","true"',
      '"","Design Group","Background Change","FALSE","0.2","Background image/color change","5","count","true"',
      '"","Design Group","Redesign","FALSE","0.48","Full redesign of existing creative","6","count","true"',
      '"","Design Group","Design Cleanup","FALSE","0.003","Minor cleanup and polish","7","count","true"',
      '"","Variable Group","Products","TRUE","1","Product variable score (count)","1","count","true"',
      '"","Variable Group","Photo Updating","FALSE","0.02","Product photo update","2","count","true"',
      '"","Variable Group","Price Updating","FALSE","0.01","Price update on creative","3","count","true"',
    ].join('\n'),
  },
  tools: {
    header: 'id,name,fixed_percentage,group_name,description,is_active',
    example: [
      '"","Ideogram","10","Design Group","AI image generation tool","true"',
      '"","ChatGPT","5","","AI text/copy tool","true"',
    ].join('\n'),
  },
  pricing_matrix: {
    header: 'id,client_name_or_code,service_name,price,percentage_rate,commission_percentage,currency,is_active',
    example: [
      '"","Sea Star Supermarket","Offer Flyer","250","","75","INR","true"',
      '"","Sea Star Supermarket","Paid Ads","","15","60","INR","true"',
      '"","B.N. Mart Supermarket","Offer Flyer","200","","75","INR","true"',
      '"","B.N. Mart Supermarket","Paid Ads","","12","60","INR","true"',
    ].join('\n'),
  },
  jobs: {
    header: 'id,task_number,title,client_name_or_code,service_name,task_date,billing_amount_inr,billing_amount,currency,quantity,status,description,is_recurring,recurring_interval,recurring_end_date',
    example: [
      '"","","Social Media Pack Jun","Sea Star Supermarket","Offer Flyer","2025-06-01","5000","5000","INR","1","done","","false","",""',
      '"","","Logo Design","SSM001","Branding","2025-06-03","8000","8000","INR","1","done","Final version delivered","false","",""',
    ].join('\n'),
  },
  contributions: {
    header: 'id,task_id,task_title,task_date,employee_cqid,score_percentage,earnings_inr',
    example: [
      '"","","Social Media Pack Jun","2025-06-01","CQ001","60","3000"',
      '"","","Social Media Pack Jun","2025-06-01","CQ002","40","2000"',
    ].join('\n'),
  },
  cashbook_entries: {
    header: 'id,entry_date,type,category_name,bank_account_name,amount,currency,amount_inr,description,reference',
    example: [
      '"","2024-01-15","inflow","Invoice Payment","HDFC Current","25000","INR","25000","Payment from Sea Star - Invoice #INV-001","INV-001"',
      '"","2024-01-20","outflow","Salary","HDFC Current","15000","INR","15000","Salary for CQ001 - January 2024",""',
      '"","2024-01-25","outflow","Software Subscription","HDFC Current","1200","INR","1200","Adobe CC monthly",""',
    ].join('\n'),
  },
  invoices: {
    header: 'id,invoice_number,client_name_or_code,issue_date,due_date,billing_period_start,billing_period_end,currency,subtotal,tax_rate,discount_amount,notes,status',
    example: [
      '"","INV-2024-001","Sea Star Supermarket","2024-01-31","2024-02-14","2024-01-01","2024-01-31","INR","50000","0","0","January 2024 services","draft"',
      '"","INV-2024-002","SSM001","2024-02-29","2024-03-14","2024-02-01","2024-02-29","INR","45000","0","0","February 2024 services","sent"',
    ].join('\n'),
  },
  invoice_status: {
    header: 'invoice_number_or_id,status,paid_amount,payment_date,payment_method,notes',
    example: [
      '"INV-2024-001","paid","50000","2024-02-10","bank_transfer","Full payment received"',
      '"INV-2024-002","partial","20000","2024-03-05","cheque","Partial payment - balance pending"',
      '"INV-2024-003","cancelled","","","","Client cancelled project"',
    ].join('\n'),
  },
  discounts: {
    header: 'id,invoice_number_or_id,client_name_or_code,discount_amount,discount_percentage,invoice_total,reason,discount_date',
    example: [
      '"","INV-2024-001","Sea Star Supermarket","2000","","50000","Year-end loyalty discount","2024-12-15"',
      '"","INV-2024-002","SSM001","","10","45000","10% promo discount","2024-12-20"',
      '"","","Sea Star Supermarket","5000","","","Goodwill discount (no specific invoice)","2024-12-25"',
    ].join('\n'),
  },
}

// ─── Export configuration ─────────────────────────────────────────────────────
// `orderBy` is tried first; if the column does not exist in the DB schema the
// export falls back to an unordered query so it still succeeds.
const EXPORT_CONFIG: Record<ImportMode, { table: string; orderBy?: string }> = {
  employees:      { table: 'employees',                orderBy: 'cqid' },
  clients:        { table: 'clients',                  orderBy: 'name' },
  services:       { table: 'services',                 orderBy: 'display_order' },
  groups:         { table: 'contribution_groups',      orderBy: 'display_order' },
  parameters:     { table: 'parameters',               orderBy: 'display_order' },
  tools:          { table: 'tools',                    orderBy: 'name' },
  pricing_matrix: { table: 'client_service_pricing',   orderBy: 'client_id' },
  jobs:           { table: 'tasks',                    orderBy: 'task_date' },
  contributions:  { table: 'contribution_scores',      orderBy: 'task_id' },
  cashbook_entries: { table: 'cashbook_entries', orderBy: 'entry_date' },
  invoices:         { table: 'invoices',          orderBy: 'issue_date' },
  invoice_status:   { table: 'invoices',          orderBy: 'invoice_number' },
  discounts:        { table: 'discount_logs',     orderBy: 'created_at' },
}

// ─── CSV output helpers ───────────────────────────────────────────────────────
function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
function toCsv(headers: string[], rows: any[]): string {
  const head = headers.join(',')
  const body = rows.map(r => headers.map(h => csvEscape(r[h])).join(',')).join('\n')
  return head + '\n' + body
}
function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// ─── Column definitions ───────────────────────────────────────────────────────
// First column `id` is always optional for Insert mode (blank = new row),
// REQUIRED for Update mode (matches the existing DB row to modify).
type ColDef = { col: string; req: boolean; notes: string }
const ID_COL: ColDef = { col: 'id', req: false, notes: 'Leave blank for new rows · REQUIRED in Update mode (use Export to get current ids)' }
const COLUMNS: Record<ImportMode, ColDef[]> = {
  employees: [
    ID_COL,
    { col: 'cqid',               req: true,  notes: 'Unique ID e.g. CQ001' },
    { col: 'name',               req: true,  notes: 'Full name' },
    { col: 'email',              req: true,  notes: 'Unique email' },
    { col: 'phone',              req: false, notes: 'Mobile number' },
    { col: 'role',               req: false, notes: 'employee / team_lead / accounts / view_only (default: employee)' },
    { col: 'salary_type',        req: false, notes: 'fixed / fixed_plus_commission / commission_only (default: fixed)' },
    { col: 'base_salary',        req: false, notes: 'Monthly base in INR' },
    { col: 'performance_rating', req: false, notes: '0–100 (default: 70)' },
    { col: 'joined_date',        req: false, notes: 'DD-MM-YYYY (also accepts YYYY-MM-DD or M/D/YYYY)' },
    { col: 'is_active',          req: false, notes: 'true / false (default: true)' },
  ],
  clients: [
    ID_COL,
    { col: 'code',             req: true,  notes: 'Unique short code e.g. SSM001' },
    { col: 'name',             req: true,  notes: 'Full client/company name' },
    { col: 'contact_name',     req: false, notes: 'Primary contact person' },
    { col: 'phone',            req: false, notes: '' },
    { col: 'email',            req: false, notes: '' },
    { col: 'address',          req: false, notes: '' },
    { col: 'gstin',            req: false, notes: 'GST number if applicable' },
    { col: 'default_currency', req: false, notes: 'INR / USD / AED etc. (default: INR)' },
    { col: 'billing_cycle',    req: false, notes: 'monthly (default) / weekly / daily / none' },
    { col: 'billing_day',      req: false, notes: 'Day of month (1-28) for monthly billing' },
    { col: 'is_active',        req: false, notes: 'true / false (default: true)' },
  ],
  services: [
    ID_COL,
    { col: 'name',             req: true,  notes: 'Service name' },
    { col: 'pricing_type',     req: true,  notes: 'fixed_per_creative / percentage_of_spend / retainer / hourly' },
    { col: 'description',      req: false, notes: '' },
    { col: 'display_order',    req: false, notes: 'Sort order number' },
    { col: 'default_price',    req: false, notes: 'Fallback price when no client-specific pricing exists' },
    { col: 'default_currency', req: false, notes: 'INR / USD / AED etc. (default: INR)' },
    { col: 'group_names',      req: false, notes: 'Contribution groups linked to this service. Separate multiple with | or , e.g. "Design Group | Variable Group". Names must match existing groups.' },
    { col: 'is_active',        req: false, notes: 'true / false (default: true)' },
  ],
  groups: [
    ID_COL,
    { col: 'name',          req: true,  notes: 'Group name e.g. Design Group' },
    { col: 'weight',        req: true,  notes: '0–100, groups must add up to 100' },
    { col: 'description',   req: false, notes: '' },
    { col: 'display_order', req: false, notes: '' },
    { col: 'is_active',     req: false, notes: 'true / false (default: true)' },
  ],
  parameters: [
    ID_COL,
    { col: 'group_name',    req: true,  notes: 'Must match an existing group name exactly' },
    { col: 'name',          req: true,  notes: 'Parameter name' },
    { col: 'is_master',     req: false, notes: 'TRUE for master parameter (Design, Products) — gets % score. FALSE for sub-parameters — get count values' },
    { col: 'weight',        req: false, notes: 'Relative weight within group. Master = 1, sub-params = decimal (0.04, 0.16 etc.)' },
    { col: 'description',   req: false, notes: '' },
    { col: 'display_order', req: false, notes: '' },
    { col: 'input_type',    req: false, notes: 'percentage / count (default: count)' },
    { col: 'is_active',     req: false, notes: 'true / false (default: true)' },
  ],
  tools: [
    ID_COL,
    { col: 'name',             req: true,  notes: 'Tool name e.g. Ideogram' },
    { col: 'fixed_percentage', req: true,  notes: '% of task billing assigned to this tool' },
    { col: 'group_name',       req: false, notes: 'Optional group association' },
    { col: 'description',      req: false, notes: '' },
    { col: 'is_active',        req: false, notes: 'true / false (default: true)' },
  ],
  pricing_matrix: [
    ID_COL,
    { col: 'client_name_or_code',  req: true,  notes: 'Client name or client code (e.g. SSM001) — or raw client_id UUID' },
    { col: 'service_name',         req: true,  notes: 'Must match service name exactly — or raw service_id UUID' },
    { col: 'price',                req: false, notes: 'Fixed price per creative (for fixed_per_creative services)' },
    { col: 'percentage_rate',      req: false, notes: '% of spend (for percentage_of_spend services)' },
    { col: 'commission_percentage',req: true,  notes: '% of billing that goes to employee pool (e.g. 75)' },
    { col: 'currency',             req: false, notes: 'INR / AED / USD etc. (default: INR)' },
    { col: 'is_active',            req: false, notes: 'true / false (default: true)' },
  ],
  jobs: [
    ID_COL,
    { col: 'task_number',         req: false, notes: 'Optional · leave blank to auto-assign next number (1, 2, 3…)' },
    { col: 'title',               req: true,  notes: 'Task name' },
    { col: 'client_name_or_code', req: false, notes: 'Client name or client code' },
    { col: 'service_name',        req: false, notes: 'Must match service name exactly' },
    { col: 'task_date',           req: true,  notes: 'DD-MM-YYYY (also accepts YYYY-MM-DD or M/D/YYYY)' },
    { col: 'billing_amount_inr',  req: false, notes: 'INR amount; no ₹ symbol' },
    { col: 'billing_amount',      req: false, notes: 'Amount in task currency (defaults to billing_amount_inr if blank)' },
    { col: 'currency',            req: false, notes: 'INR / USD / AED etc. (default: INR)' },
    { col: 'quantity',            req: false, notes: 'Hours / items / spend (default: 1)' },
    { col: 'status',              req: false, notes: 'pending / in_progress / done / invoiced / cancelled (default: done)' },
    { col: 'description',         req: false, notes: '' },
    { col: 'is_recurring',        req: false, notes: 'true / false' },
    { col: 'recurring_interval',  req: false, notes: 'daily / weekly / biweekly / monthly' },
    { col: 'recurring_end_date',  req: false, notes: 'DD-MM-YYYY when the recurrence stops (also accepts YYYY-MM-DD)' },
  ],
  contributions: [
    ID_COL,
    { col: 'task_id',          req: false, notes: 'Optional · use raw task UUID if available (faster lookup)' },
    { col: 'task_title',       req: true,  notes: 'Exact task title in DB — import jobs first (ignored if task_id is provided)' },
    { col: 'task_date',        req: true,  notes: 'DD-MM-YYYY (also accepts YYYY-MM-DD) — used to find the task (with task_title)' },
    { col: 'employee_cqid',    req: true,  notes: 'e.g. CQ001' },
    { col: 'score_percentage', req: true,  notes: '0–100' },
    { col: 'earnings',         req: true,  notes: 'INR amount' },
  ],
  cashbook_entries: [
    ID_COL,
    { col: 'entry_date',        req: true,  notes: 'DD-MM-YYYY (also accepts YYYY-MM-DD)' },
    { col: 'type',              req: true,  notes: 'inflow / outflow' },
    { col: 'category_name',     req: false, notes: 'Must match a category name in Cash Categories settings' },
    { col: 'bank_account_name', req: false, notes: 'Must match a bank account name in Bank Accounts settings' },
    { col: 'amount',            req: true,  notes: 'Amount in the transaction currency' },
    { col: 'currency',          req: false, notes: 'INR / AED / USD etc. (default: INR)' },
    { col: 'amount_inr',        req: false, notes: 'INR equivalent (defaults to amount if currency is INR)' },
    { col: 'description',       req: false, notes: 'Description / notes' },
    { col: 'reference',         req: false, notes: 'Reference number, invoice number, etc.' },
  ],
  invoices: [
    ID_COL,
    { col: 'invoice_number',        req: true,  notes: 'Unique invoice number e.g. INV-2024-001' },
    { col: 'client_name_or_code',   req: true,  notes: 'Client name or client code' },
    { col: 'issue_date',            req: true,  notes: 'DD-MM-YYYY' },
    { col: 'due_date',              req: false, notes: 'DD-MM-YYYY (default: issue_date + 14 days)' },
    { col: 'billing_period_start',  req: false, notes: 'DD-MM-YYYY — month/period start' },
    { col: 'billing_period_end',    req: false, notes: 'DD-MM-YYYY — month/period end' },
    { col: 'currency',              req: false, notes: 'INR / AED / USD etc. (default: INR)' },
    { col: 'subtotal',              req: false, notes: 'Invoice subtotal amount' },
    { col: 'tax_rate',              req: false, notes: 'Tax % (default: 0)' },
    { col: 'discount_amount',       req: false, notes: 'Discount amount (default: 0)' },
    { col: 'notes',                 req: false, notes: 'Invoice notes' },
    { col: 'status',                req: false, notes: 'draft / reviewed / sent / partial / paid / cancelled (default: draft)' },
  ],
  invoice_status: [
    { col: 'invoice_number_or_id', req: true,  notes: 'Invoice number (e.g. INV-2024-001) or raw UUID' },
    { col: 'status',               req: true,  notes: 'draft / reviewed / sent / partial / paid / cancelled / bad_debt / overdue' },
    { col: 'paid_amount',          req: false, notes: 'Amount paid — required when status is partial or paid' },
    { col: 'payment_date',         req: false, notes: 'DD-MM-YYYY' },
    { col: 'payment_method',       req: false, notes: 'bank_transfer / cheque / cash / upi / other' },
    { col: 'notes',                req: false, notes: 'Payment or status change notes' },
  ],
  discounts: [
    ID_COL,
    { col: 'invoice_number_or_id', req: false, notes: 'Invoice number (e.g. INV-2024-001) or UUID — optional. Leave blank for client-level/standalone discount' },
    { col: 'client_name_or_code',  req: true,  notes: 'Client name or code (e.g. SSM001) — required when no invoice ref' },
    { col: 'discount_amount',      req: false, notes: 'Flat discount in INR — either this or discount_percentage is required' },
    { col: 'discount_percentage',  req: false, notes: '% discount applied — either this or discount_amount is required' },
    { col: 'invoice_total',        req: false, notes: 'Invoice total at the time of discount (for record-keeping; defaults to 0 if no invoice ref)' },
    { col: 'reason',               req: false, notes: 'Reason / note for the discount' },
    { col: 'discount_date',        req: false, notes: 'DD-MM-YYYY when the discount was given (defaults to today)' },
  ],
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const lines: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') inQuote = false
      else field += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { row.push(field.trim()); field = '' }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++
        row.push(field.trim()); field = ''
        if (row.some(c => c !== '')) lines.push(row)
        row = []
      } else field += ch
    }
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.some(c => c !== '')) lines.push(row) }
  return lines
}

function norm(s: string) { return (s || '').toLowerCase().trim() }

/** Normalise any common date format to YYYY-MM-DD.
 *  Handles: YYYY-MM-DD, M/D/YY, M/D/YYYY, DD-MM-YYYY */
function normalizeDate(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // YYYY/MM/DD
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, '-')
  // Slash-delimited: D/M/YYYY or M/D/YYYY — default to D/M/YYYY (Indian convention)
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slash) {
    let [, a, b, y] = slash
    if (y.length === 2) y = (parseInt(y) >= 50 ? '19' : '20') + y
    const aNum = parseInt(a), bNum = parseInt(b)
    let d: string, m: string
    if (aNum > 12) {
      // First part > 12 → must be day (D/M/YYYY)
      d = a; m = b
    } else if (bNum > 12) {
      // Second part > 12 → must be day, so first is month (M/D/YYYY)
      m = a; d = b
    } else {
      // Ambiguous — use D/M/YYYY (Indian convention)
      d = a; m = b
    }
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // DD-MM-YYYY (e.g. 01-05-2026)
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (dmy) {
    const [, d, m, y] = dmy
    return `${y}-${m}-${d}`
  }
  return s  // return as-is; validation will catch it
}


function downloadTemplate(mode: ImportMode) {
  const { header, example } = TEMPLATES[mode]
  const blob = new Blob([header + '\n' + example], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${mode}_import_template.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ─── Shared UI pieces ─────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: 'ok' | 'warn' | 'error' }) {
  if (status === 'ok')    return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-semibold">OK</span>
  if (status === 'warn')  return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">WARN</span>
  return                         <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">ERR</span>
}

function IssueCell({ row }: { row: ParsedRow }) {
  return (
    <td className="px-3 py-2 max-w-[220px]">
      {[...row.errors, ...row.warnings].map((msg, i) => (
        <div key={i} className={`text-[10px] leading-tight ${row.errors.includes(msg) ? 'text-red-400' : 'text-yellow-400'}`}>{msg}</div>
      ))}
    </td>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ImportClient({ clients, services, employees, groups, parameters, bankAccounts, cashCategories }: Props) {
  const supabase = createClient()
  const { toasts, dismiss, success, error: toastError } = useToast()

  const [pageTab, setPageTab] = useState<'import' | 'cleanup'>('import')

  // ── Import state ───────────────────────────────────────────────────────────
  const [mode, setMode]     = useState<ImportMode>('employees')
  const [operation, setOperation] = useState<'insert' | 'update' | 'delete'>('insert')
  const [step, setStep]     = useState<'upload' | 'preview' | 'done'>('upload')
  const [rows, setRows]     = useState<ParsedRow[]>([])
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Reset operation when changing modes
  useEffect(() => { setOperation('insert') }, [mode])

  // ── Contribution sub-mode ──────────────────────────────────────────────────
  const [contribSubMode, setContribSubMode] = useState<ContribSubMode>('score_pct')

  // ── Clean-up state ─────────────────────────────────────────────────────────
  const [cleanupMode, setCleanupMode] = useState<ImportMode>('employees')
  const [cleanupRecords, setCleanupRecords] = useState<any[]>([])
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [deleting, setDeleting]         = useState(false)

  // Lookup maps
  const clientMap  = useMemo(() => { const m: Record<string, string> = {}; clients.forEach(c => { m[norm(c.name)] = c.id; m[norm(c.code)] = c.id }); return m }, [clients])
  const serviceMap = useMemo(() => { const m: Record<string, string> = {}; services.forEach(s => { m[norm(s.name)] = s.id }); return m }, [services])
  const empMap     = useMemo(() => { const m: Record<string, string> = {}; employees.forEach(e => { m[norm(e.cqid)] = e.id }); return m }, [employees])
  const groupMap   = useMemo(() => { const m: Record<string, string> = {}; groups.forEach(g => { m[norm(g.name)] = g.id }); return m }, [groups])
  const bankAccountMap = useMemo(() => { const m: Record<string, string> = {}; bankAccounts.forEach(b => { m[norm(b.name)] = b.id }); return m }, [bankAccounts])
  const cashCategoryMap = useMemo(() => { const m: Record<string, string> = {}; cashCategories.forEach(c => { m[norm(c.name)] = c.id }); return m }, [cashCategories])

  // ── Export current data ────────────────────────────────────────────────────
  async function exportCurrentData(m: ImportMode) {
    const cfg = EXPORT_CONFIG[m]
    // Try ordered first; if the orderBy column is missing on this DB schema,
    // retry without ordering so the export still works.
    let data: any[] | null = null
    let lastError: any = null
    if (cfg.orderBy) {
      const ordered = await supabase.from(cfg.table).select('*').order(cfg.orderBy, { ascending: true, nullsFirst: false })
      if (ordered.error) lastError = ordered.error
      else data = ordered.data as any[]
    }
    if (!data) {
      const plain = await supabase.from(cfg.table).select('*')
      if (plain.error) {
        toastError(`Export failed: ${plain.error.message}`)
        return
      }
      data = plain.data as any[]
      if (lastError) {
        // Silent fallback worked — let the user know ordering was skipped
        console.warn(`Export ordering by "${cfg.orderBy}" skipped: ${lastError.message}`)
      }
    }
    if (!data || data.length === 0) { toastError('No data to export'); return }

    // ── Enrichment per mode ──
    // Services: append a `group_names` column (pipe-separated) so the export
    // is round-trippable through import (which now accepts group_names).
    if (m === 'services') {
      const [gsRes, grpRes] = await Promise.all([
        supabase.from('group_services').select('group_id, service_id'),
        supabase.from('contribution_groups').select('id, name'),
      ])
      if (!gsRes.error && !grpRes.error) {
        const groupNameById: Record<string, string> = {}
        ;(grpRes.data || []).forEach((g: any) => { groupNameById[g.id] = g.name })
        const groupsByService: Record<string, string[]> = {}
        ;(gsRes.data || []).forEach((row: any) => {
          if (!groupsByService[row.service_id]) groupsByService[row.service_id] = []
          if (groupNameById[row.group_id]) groupsByService[row.service_id].push(groupNameById[row.group_id])
        })
        data = data.map((r: any) => ({ ...r, group_names: (groupsByService[r.id] || []).join(' | ') }))
      }
    }

    // Discounts: enrich with invoice_number + client_name_or_code for human-readable export
    if (m === 'discounts') {
      const invIds = [...new Set(data.map((r: any) => r.invoice_id).filter(Boolean))]
      const clIds  = [...new Set(data.map((r: any) => r.client_id).filter(Boolean))]
      const [invRes, clRes] = await Promise.all([
        invIds.length ? supabase.from('invoices').select('id, invoice_number').in('id', invIds) : Promise.resolve({ data: [] as any[], error: null }),
        clIds.length  ? supabase.from('clients').select('id, name, code').in('id', clIds)        : Promise.resolve({ data: [] as any[], error: null }),
      ])
      const invByid = new Map<string, string>(); ((invRes as any).data || []).forEach((i: any) => invByid.set(i.id, i.invoice_number))
      const clByid  = new Map<string, string>(); ((clRes  as any).data || []).forEach((c: any) => clByid.set(c.id,  c.code || c.name))
      data = data.map((r: any) => ({
        ...r,
        invoice_number_or_id: r.invoice_id ? (invByid.get(r.invoice_id) || r.invoice_id) : '',
        client_name_or_code:  r.client_id  ? (clByid.get(r.client_id)   || '')           : '',
        discount_date:        r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
      }))
    }

    const allKeys = new Set<string>()
    data.forEach((r: Record<string, unknown>) => Object.keys(r).forEach(k => allKeys.add(k)))
    const headers = ['id', ...[...allKeys].filter(k => k !== 'id').sort()]
    const csv = toCsv(headers, data)
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    downloadCsv(`${m}_export_${ts}.csv`, csv)
    success(`Exported ${data.length} row${data.length !== 1 ? 's' : ''}`)
  }

  // ── Parsers ────────────────────────────────────────────────────────────────
  function baseRow(i: number): ParsedRow { return { _line: i + 2, errors: [], warnings: [], status: 'ok' } }
  function finalize(r: ParsedRow): ParsedRow {
    r.status = r.errors.length ? 'error' : r.warnings.length ? 'warn' : 'ok'
    return r
  }

  function parseEmployees(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iCqid = idx('cqid'), iName = idx('name'), iEmail = idx('email')
    const iPhone = idx('phone'), iRole = idx('role'), iSalType = idx('salary')
    const iBase = idx('base'), iRating = idx('rating'), iJoined = idx('joined')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), cqid: g(iCqid), name: g(iName), email: g(iEmail),
        phone: g(iPhone), role: g(iRole) || 'employee', salary_type: g(iSalType) || 'fixed',
        base_salary: g(iBase), performance_rating: g(iRating) || '70', joined_date: normalizeDate(g(iJoined)) }
      if (!r.cqid)  r.errors.push('cqid is required')
      if (!r.name)  r.errors.push('name is required')
      if (!r.email) r.errors.push('email is required')
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) r.errors.push('email format invalid')
      const validRoles = ['super_admin','accounts','team_lead','employee','view_only']
      if (r.role && !validRoles.includes(r.role)) r.errors.push(`role "${r.role}" invalid`)
      const validSalTypes = ['fixed','commission_only','fixed_plus_commission','pure_commission','base_plus_commission','fixed_plus_bonus','hourly']
      if (r.salary_type && !validSalTypes.includes(r.salary_type)) r.errors.push(`salary_type "${r.salary_type}" invalid`)
      if (r.joined_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.joined_date)) r.errors.push('joined_date must be DD-MM-YYYY (e.g. 18-05-2026)')
      return finalize(r)
    })
  }

  function parseClients(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iCode = idx('code'), iName = idx('name'), iContact = idx('contact')
    const iPhone = idx('phone'), iEmail = idx('email'), iAddr = idx('address')
    const iGst = idx('gst'), iCurr = idx('currency')
    const iBillingCycle = h.findIndex(c => c === 'billing_cycle' || c === 'billingcycle')
    const iBillingDay   = h.findIndex(c => c === 'billing_day'   || c === 'billingday')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const billingCycle = g(iBillingCycle) || 'monthly'
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), code: g(iCode), name: g(iName), contact_name: g(iContact),
        phone: g(iPhone), email: g(iEmail), address: g(iAddr), gstin: g(iGst),
        default_currency: g(iCurr) || 'INR',
        billing_cycle: billingCycle,
        billing_day: g(iBillingDay) || '1',
      }
      if (!r.code) r.errors.push('code is required')
      if (!r.name) r.errors.push('name is required')
      const validCycles = ['monthly','weekly','daily','none']
      if (r.billing_cycle && !validCycles.includes(r.billing_cycle)) r.errors.push(`billing_cycle "${r.billing_cycle}" invalid — use monthly/weekly/daily/none`)
      return finalize(r)
    })
  }

  function parseServices(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    // Use EXACT match for 'name' to avoid matching 'group_names'
    const iId = h.findIndex(c => c === 'id')
    const iName = h.findIndex(c => c === 'name')        // exact — not group_names
    const iPricing = h.findIndex(c => c.includes('pricing'))
    const iDesc = h.findIndex(c => c.includes('desc'))
    const iOrd  = h.findIndex(c => c.includes('order'))
    const iDefaultPrice = h.findIndex(c => c === 'default_price' || c === 'defaultprice')
    const iDefaultCurr  = h.findIndex(c => c === 'default_currency' || (c.includes('currency') && !c.includes('default') ? false : c.includes('currency')))
    const iGroupNames   = h.findIndex(c => c === 'group_names' || c === 'groups' || c === 'contribution_groups')
    const iActive = h.findIndex(c => c === 'is_active' || c === 'active')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const activeRaw = g(iActive)
      const groupNamesRaw = g(iGroupNames)
      // Split on | or , and trim — supports "Design Group | Variable Group" or "Design Group, Variable Group"
      const groupNames = groupNamesRaw
        ? groupNamesRaw.split(/[|,]/).map(s => s.trim()).filter(Boolean)
        : []
      const groupIds: string[] = []
      const missingGroups: string[] = []
      for (const gn of groupNames) {
        const gid = groupMap[norm(gn)]
        if (gid) groupIds.push(gid)
        else missingGroups.push(gn)
      }
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), name: g(iName), pricing_type: g(iPricing) || 'fixed_per_creative',
        description: g(iDesc), display_order: g(iOrd) || '0',
        default_price: g(iDefaultPrice), default_currency: g(iDefaultCurr) || 'INR',
        group_names: groupNames, group_ids: groupIds,
        is_active: activeRaw === '' || activeRaw === 'true' || activeRaw === 'TRUE' || activeRaw === '1',
      }
      if (!r.name) r.errors.push('name is required')
      const valid = ['fixed_per_creative','percentage_of_spend','retainer','hourly']
      if (!valid.includes(r.pricing_type)) r.errors.push(`pricing_type "${r.pricing_type}" invalid`)
      if (r.default_price && isNaN(parseFloat(r.default_price))) r.errors.push('default_price must be a number')
      if (missingGroups.length > 0) r.warnings.push(`Group(s) not found: ${missingGroups.join(', ')} — these will be skipped`)
      return finalize(r)
    })
  }

  function parseGroups(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iName = idx('name'), iWeight = idx('weight'), iDesc = idx('desc'), iOrd = idx('order')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), name: g(iName), weight: g(iWeight),
        description: g(iDesc), display_order: g(iOrd) || '0' }
      if (!r.name) r.errors.push('name is required')
      if (!r.weight) r.errors.push('weight is required')
      else if (isNaN(parseFloat(r.weight))) r.errors.push('weight must be a number')
      return finalize(r)
    })
  }

  function parseParameters(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    // Use EXACT match for 'name' to avoid matching 'group_name'
    const iId      = h.findIndex(c => c === 'id')
    const iGroup   = h.findIndex(c => c === 'group_name' || c === 'group')
    const iName    = h.findIndex(c => c === 'name')          // exact — not group_name
    const iWeight  = h.findIndex(c => c.includes('weight'))
    const iDesc    = h.findIndex(c => c.includes('desc'))
    const iOrd     = h.findIndex(c => c.includes('order'))
    const iMaster  = h.findIndex(c => c.includes('master') || c.includes('is_master'))

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const masterVal = g(iMaster)
      const is_master = masterVal === 'TRUE' || masterVal === 'true' || masterVal === '1' || masterVal === 'yes'
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), group_name: g(iGroup), name: g(iName),
        weight: g(iWeight) || '1', description: g(iDesc), display_order: g(iOrd) || '0', is_master }
      if (!r.name)       r.errors.push('name is required')
      if (!r.group_name) r.errors.push('group_name is required')
      else {
        r.group_id = groupMap[norm(r.group_name)]
        if (!r.group_id) r.errors.push(`Group "${r.group_name}" not found — create the group first`)
      }
      return finalize(r)
    })
  }

  function parseTools(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iName = idx('name'), iPct = h.findIndex(c => c.includes('percent') || c.includes('pct') || c === 'fixed_percentage')
    const iGroup = idx('group'), iDesc = idx('desc')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const r: ParsedRow = { ...baseRow(i), row_id: g(iId), name: g(iName), fixed_percentage: g(iPct),
        group_name: g(iGroup), description: g(iDesc) }
      if (!r.name) r.errors.push('name is required')
      if (!r.fixed_percentage) r.errors.push('fixed_percentage is required')
      else if (isNaN(parseFloat(r.fixed_percentage))) r.errors.push('fixed_percentage must be a number')
      if (r.group_name) {
        r.group_id = groupMap[norm(r.group_name)]
        if (!r.group_id) r.warnings.push(`Group "${r.group_name}" not found — tool will be saved without group`)
      }
      return finalize(r)
    })
  }

  function parsePricingMatrix(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const iId      = h.findIndex(c => c === 'id')
    const iClient  = h.findIndex(c => c.includes('client'))
    const iService = h.findIndex(c => c.includes('service'))
    const iPrice   = h.findIndex(c => c === 'price' || c === 'fixed_price')
    const iPct     = h.findIndex(c => c.includes('percentage_rate') || c === 'pct_rate')
    const iComm    = h.findIndex(c => c.includes('commission'))
    const iCurr    = h.findIndex(c => c.includes('currency'))

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iId),
        client_ref: g(iClient), service_ref: g(iService),
        price: g(iPrice), percentage_rate: g(iPct),
        commission_percentage: g(iComm), currency: g(iCurr) || 'INR',
      }
      const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      if (!r.client_ref) r.errors.push('client_name_or_code is required')
      else if (isUuid(r.client_ref)) { r.client_id = r.client_ref }
      else {
        r.client_id = clientMap[norm(r.client_ref)]
        if (!r.client_id) r.errors.push(`Client "${r.client_ref}" not found`)
      }
      if (!r.service_ref) r.errors.push('service_name is required')
      else if (isUuid(r.service_ref)) { r.service_id = r.service_ref }
      else {
        r.service_id = serviceMap[norm(r.service_ref)]
        if (!r.service_id) r.errors.push(`Service "${r.service_ref}" not found`)
      }
      if (!r.commission_percentage) r.errors.push('commission_percentage is required')
      else if (isNaN(parseFloat(r.commission_percentage))) r.errors.push('commission_percentage must be a number')
      if (!r.price && !r.percentage_rate) r.warnings.push('No price or percentage_rate — row will be saved with zero pricing')
      if (r.price && isNaN(parseFloat(r.price))) r.errors.push('price must be a number')
      if (r.percentage_rate && isNaN(parseFloat(r.percentage_rate))) r.errors.push('percentage_rate must be a number')
      const validCurrencies = ['INR','AED','SAR','USD','QAR','GBP','EUR']
      if (r.currency && !validCurrencies.includes(r.currency.toUpperCase())) r.warnings.push(`Currency "${r.currency}" not recognised — defaulting to INR`)
      return finalize(r)
    })
  }

  function parseJobs(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const idx = (k: string) => h.findIndex(c => c.includes(k))
    const iId = h.findIndex(c => c === 'id')
    const iNumber = h.findIndex(c => c === 'task_number' || c === 'number' || c === 'task#' || c === 'no' || c === 'task_no')
    const iTitle = idx('title'), iClient = h.findIndex(c => c.includes('client'))
    const iService = h.findIndex(c => c.includes('service')), iDate = h.findIndex(c => c.includes('date'))
    const iAmountInr = h.findIndex(c => c === 'billing_amount_inr' || c === 'billing_amount_inr')
    const iAmount    = h.findIndex(c => c === 'billing_amount')
    const iCurr      = h.findIndex(c => c === 'currency')
    const iQty       = h.findIndex(c => c === 'quantity' || c === 'qty')
    const iStatus    = idx('status'), iDesc = h.findIndex(c => c.includes('desc'))
    const iRecurring = h.findIndex(c => c === 'is_recurring' || c === 'recurring')
    const iRecInt    = h.findIndex(c => c === 'recurring_interval')
    const iRecEnd    = h.findIndex(c => c === 'recurring_end_date')

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const tnRaw = g(iNumber).replace(/^#/, '').trim()
      // billing_amount_inr takes precedence; fall back to billing_amount
      const billingInr = g(iAmountInr) || g(iAmount)
      const billingAmt = g(iAmount) || g(iAmountInr)
      const recurringRaw = g(iRecurring)
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iId), task_number: tnRaw, title: g(iTitle), client_ref: g(iClient),
        service_ref: g(iService), task_date: normalizeDate(g(iDate)),
        billing_amount_inr: billingInr, billing_amount: billingAmt,
        currency: g(iCurr) || 'INR',
        quantity: g(iQty) || '1',
        task_status: g(iStatus) || 'done', description: g(iDesc),
        is_recurring: recurringRaw === 'true' || recurringRaw === 'TRUE' || recurringRaw === '1',
        recurring_interval: g(iRecInt) || null,
        recurring_end_date: g(iRecEnd) ? normalizeDate(g(iRecEnd)) : null,
      }
      if (!r.title)     r.errors.push('title is required')
      if (!r.task_date) r.errors.push('task_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.task_date)) r.errors.push('task_date must be DD-MM-YYYY (e.g. 18-05-2026)')
      if (tnRaw && !/^\d+$/.test(tnRaw)) r.errors.push('task_number must be a whole number')
      if (r.client_ref) { r.client_id = clientMap[norm(r.client_ref)]; if (!r.client_id) r.warnings.push(`Client "${r.client_ref}" not found`) }
      if (r.service_ref) { r.service_id = serviceMap[norm(r.service_ref)]; if (!r.service_id) r.warnings.push(`Service "${r.service_ref}" not found`) }
      if (r.billing_amount_inr && isNaN(parseFloat(r.billing_amount_inr))) r.errors.push('billing_amount_inr must be a number')
      if (r.quantity && isNaN(parseFloat(r.quantity))) r.errors.push('quantity must be a number')
      const validSt = ['pending','in_progress','done','invoiced','cancelled']
      if (r.task_status && !validSt.includes(r.task_status)) r.errors.push(`status "${r.task_status}" invalid`)
      const validIntervals = ['daily','weekly','biweekly','monthly']
      if (r.recurring_interval && !validIntervals.includes(r.recurring_interval)) r.errors.push(`recurring_interval "${r.recurring_interval}" invalid`)
      if (r.recurring_end_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.recurring_end_date)) r.errors.push('recurring_end_date must be DD-MM-YYYY (e.g. 18-05-2026)')
      return finalize(r)
    })
  }

  async function parseContributions(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iRowId = h.findIndex(c => c === 'id')
    const iId    = h.findIndex(c => c === 'task_id')
    const iTask  = h.findIndex(c => c.includes('task') && c !== 'task_id' && c !== 'id')
    const iDate  = h.findIndex(c => c.includes('date'))
    const iCqid  = h.findIndex(c => c.includes('cqid') || c === 'employee_cqid')
    const iScore = h.findIndex(c => c.includes('score') || c.includes('pct') || c.includes('percent'))
    const iEarn  = h.findIndex(c => c.includes('earn'))

    // Build task lookup from title+date for rows without direct task_id
    const titlesToFetch = [...new Set(
      lines.slice(1).filter(c => !c[iId]?.trim()).map(c => c[iTask]?.trim()).filter(Boolean)
    )]
    const taskMap: Record<string, string> = {}
    if (titlesToFetch.length) {
      const { data: tasksData } = await supabase.from('tasks').select('id, title, task_date').in('title', titlesToFetch)
      ;(tasksData || []).forEach(t => { taskMap[`${t.title}|||${t.task_date}`] = t.id })
    }

    // For param_detail: map CSV column → parameter
    const paramColMap: { idx: number; param: RefParameter }[] = []
    if (contribSubMode === 'param_detail') {
      for (let ci = 0; ci < h.length; ci++) {
        const matched = parameters.find(p => norm(p.name) === h[ci])
        if (matched) paramColMap.push({ idx: ci, param: matched })
      }
    }

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const taskDate = normalizeDate(g(iDate))
      const r: ParsedRow = {
        ...baseRow(i),
        row_id: g(iRowId),
        task_id_direct: g(iId),
        task_ref: g(iTask),
        task_date: taskDate,
        employee_cqid: g(iCqid),
        score_percentage: g(iScore),
        earnings: g(iEarn),
        _paramValues: {} as Record<string, string>,
      }

      // ── Resolve task ──────────────────────────────────────────────────────
      if (r.task_id_direct) {
        r.task_id = r.task_id_direct
      } else {
        if (!r.task_ref)  r.errors.push('task_title is required (or provide task_id column)')
        if (!r.task_date) r.errors.push('task_date is required')
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.task_date)) r.errors.push('task_date must be DD-MM-YYYY (e.g. 18-05-2026)')
        if (r.task_ref && r.task_date) {
          r.task_id = taskMap[`${r.task_ref}|||${r.task_date}`]
          if (!r.task_id) r.warnings.push(`Task not matched — check title & date match exactly`)
        }
      }

      // ── Resolve employee ─────────────────────────────────────────────────
      if (!r.employee_cqid) r.errors.push('employee_cqid is required')
      else {
        r.employee_id = empMap[norm(r.employee_cqid)]
        if (!r.employee_id) r.errors.push(`Employee "${r.employee_cqid}" not found`)
      }

      // ── Mode-specific validation ─────────────────────────────────────────
      if (contribSubMode === 'earnings_only') {
        if (!r.earnings) r.errors.push('earnings_inr is required')
        else if (isNaN(parseFloat(r.earnings))) r.errors.push('earnings_inr must be a number')
      } else if (contribSubMode === 'score_pct') {
        if (!r.score_percentage) r.errors.push('score_percentage is required')
        const s = parseFloat(r.score_percentage)
        if (r.score_percentage && (isNaN(s) || s < 0 || s > 100)) r.errors.push('score_percentage must be 0–100')
        if (r.earnings && isNaN(parseFloat(r.earnings))) r.errors.push('earnings_inr must be a number')
      } else {
        // param_detail — collect per-parameter values
        for (const { idx, param } of paramColMap) {
          const val = c[idx]?.trim() || '0'
          r._paramValues[param.id] = val
        }
        if (paramColMap.length === 0) r.warnings.push('No parameter columns matched — headers must equal parameter names exactly')
      }

      return finalize(r)
    })
  }

  function parseCashbookEntries(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const iId       = h.findIndex(c => c === 'id')
    const iDate     = h.findIndex(c => c.includes('entry_date') || c.includes('date'))
    const iType     = h.findIndex(c => c === 'type')
    const iCat      = h.findIndex(c => c.includes('category'))
    const iBank     = h.findIndex(c => c.includes('bank') || c.includes('account'))
    const iAmt      = h.findIndex(c => c === 'amount')
    const iCurr     = h.findIndex(c => c === 'currency')
    const iAmtInr   = h.findIndex(c => c.includes('amount_inr') || c.includes('inr'))
    const iDesc     = h.findIndex(c => c.includes('description') || c.includes('desc'))
    const iRef      = h.findIndex(c => c.includes('reference') || c.includes('ref'))

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const catName  = g(iCat)
      const bankName = g(iBank)
      const currency = g(iCurr) || 'INR'
      const amount   = g(iAmt)
      const amtInr   = g(iAmtInr) || (currency === 'INR' ? amount : '')
      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        entry_date: normalizeDate(g(iDate)),
        type: g(iType) || 'inflow',
        category_name: catName,
        category_id: catName ? cashCategoryMap[norm(catName)] : undefined,
        bank_account_name: bankName,
        bank_account_id: bankName ? bankAccountMap[norm(bankName)] : undefined,
        amount, currency, amount_inr: amtInr,
        description: g(iDesc), reference: g(iRef),
      }
      if (!r.entry_date) r.errors.push('entry_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.entry_date)) r.errors.push('entry_date must be DD-MM-YYYY')
      if (!['inflow', 'outflow'].includes(r.type)) r.errors.push('type must be inflow or outflow')
      if (!r.amount) r.errors.push('amount is required')
      else if (isNaN(parseFloat(r.amount))) r.errors.push('amount must be a number')
      if (catName && !r.category_id) r.warnings.push(`Category "${catName}" not found — will leave blank`)
      if (bankName && !r.bank_account_id) r.warnings.push(`Bank account "${bankName}" not found — will leave blank`)
      return finalize(r)
    })
  }

  function parseInvoices(lines: string[][]): ParsedRow[] {
    const h = lines[0].map(norm)
    const iId       = h.findIndex(c => c === 'id')
    const iNum      = h.findIndex(c => c.includes('invoice_number') || c.includes('number'))
    const iClient   = h.findIndex(c => c.includes('client'))
    const iIssue    = h.findIndex(c => c.includes('issue'))
    const iDue      = h.findIndex(c => c.includes('due'))
    const iPStart   = h.findIndex(c => c.includes('period_start') || c.includes('start'))
    const iPEnd     = h.findIndex(c => c.includes('period_end') || c.includes('end'))
    const iCurr     = h.findIndex(c => c === 'currency')
    const iSub      = h.findIndex(c => c.includes('subtotal'))
    const iTax      = h.findIndex(c => c.includes('tax'))
    const iDisc     = h.findIndex(c => c.includes('discount'))
    const iNotes    = h.findIndex(c => c.includes('notes'))
    const iStatus   = h.findIndex(c => c === 'status')

    const validStatuses = ['draft','reviewed','sent','partial','paid','cancelled','bad_debt','overdue']

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const clientRef = g(iClient)
      const issueDate = normalizeDate(g(iIssue))
      let dueDate = normalizeDate(g(iDue))
      if (!dueDate && issueDate) {
        // Default due date: issue + 14 days
        const d = new Date(issueDate)
        d.setDate(d.getDate() + 14)
        dueDate = d.toISOString().slice(0, 10)
      }
      const invoiceStatus = g(iStatus) || 'draft'
      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        invoice_number: g(iNum),
        client_ref: clientRef,
        client_id: clientRef ? clientMap[norm(clientRef)] : undefined,
        issue_date: issueDate, due_date: dueDate,
        billing_period_start: normalizeDate(g(iPStart)),
        billing_period_end:   normalizeDate(g(iPEnd)),
        currency: g(iCurr) || 'INR',
        subtotal: g(iSub) || '0',
        tax_rate: g(iTax) || '0',
        discount_amount: g(iDisc) || '0',
        notes: g(iNotes), invoice_status: invoiceStatus,
      }
      if (!r.invoice_number) r.errors.push('invoice_number is required')
      if (!r.client_id) r.errors.push(`Client "${clientRef}" not found — must match an existing client name or code`)
      if (!r.issue_date) r.errors.push('issue_date is required')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(r.issue_date)) r.errors.push('issue_date must be DD-MM-YYYY')
      if (!validStatuses.includes(invoiceStatus)) r.errors.push(`status "${invoiceStatus}" invalid`)
      return finalize(r)
    })
  }

  async function parseInvoiceStatus(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iRef    = h.findIndex(c => c.includes('invoice_number') || c.includes('number') || c.includes('id'))
    const iStatus = h.findIndex(c => c === 'status')
    const iPaid   = h.findIndex(c => c.includes('paid_amount') || c.includes('paid'))
    const iDate   = h.findIndex(c => c.includes('payment_date') || c.includes('date'))
    const iMethod = h.findIndex(c => c.includes('method') || c.includes('payment_method'))
    const iNotes  = h.findIndex(c => c.includes('notes'))

    // Pre-load invoice number → id map
    const { data: invRows } = await supabase.from('invoices').select('id, invoice_number')
    const invMap: Record<string, string> = {}
    ;(invRows || []).forEach((inv: any) => { invMap[norm(inv.invoice_number)] = inv.id })

    const validStatuses = ['draft','reviewed','sent','partial','paid','cancelled','bad_debt','overdue']
    const validMethods  = ['bank_transfer','cheque','cash','upi','online','other','']

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const ref           = g(iRef)
      const invoiceStatus = g(iStatus)
      const isUUID = /^[0-9a-f-]{36}$/i.test(ref)
      const invId  = isUUID ? ref : invMap[norm(ref)]
      const r: ParsedRow = {
        ...baseRow(i), row_id: undefined,
        invoice_ref: ref, invoice_id: invId,
        invoice_status: invoiceStatus, paid_amount: g(iPaid),
        payment_date: normalizeDate(g(iDate)),
        payment_method: g(iMethod) || '',
        notes: g(iNotes),
      }
      if (!ref) r.errors.push('invoice_number_or_id is required')
      else if (!invId) r.errors.push(`Invoice "${ref}" not found in database`)
      if (!invoiceStatus) r.errors.push('status is required')
      else if (!validStatuses.includes(invoiceStatus)) r.errors.push(`status "${invoiceStatus}" invalid — use: ${validStatuses.join(', ')}`)
      if ((invoiceStatus === 'partial' || invoiceStatus === 'paid') && !r.paid_amount) r.warnings.push('paid_amount recommended when status is partial or paid')
      if (r.payment_method && !validMethods.includes(r.payment_method)) r.warnings.push(`payment_method "${r.payment_method}" not standard`)
      return finalize(r)
    })
  }

  async function parseDiscounts(lines: string[][]): Promise<ParsedRow[]> {
    const h = lines[0].map(norm)
    const iId         = h.findIndex(c => c === 'id')
    const iInvoiceRef = h.findIndex(c => c.includes('invoice_number') || c.includes('invoice_id') || c === 'invoice_ref')
    const iClient     = h.findIndex(c => c.includes('client'))
    const iAmount     = h.findIndex(c => c === 'discount_amount' || c === 'amount')
    const iPct        = h.findIndex(c => c === 'discount_percentage' || c === 'percentage' || c === 'percent')
    const iTotal      = h.findIndex(c => c.includes('invoice_total') || c === 'total')
    const iReason     = h.findIndex(c => c.includes('reason') || c.includes('note'))
    const iDate       = h.findIndex(c => c.includes('discount_date') || c.includes('date'))

    // Pre-load invoice number → id map
    const { data: invRows } = await supabase.from('invoices').select('id, invoice_number, client_id, total_amount')
    const invMap: Record<string, { id: string; client_id: string; total: number }> = {}
    ;(invRows || []).forEach((inv: any) => { invMap[norm(inv.invoice_number)] = { id: inv.id, client_id: inv.client_id, total: inv.total_amount || 0 } })

    return lines.slice(1).map((c, i) => {
      const g = (j: number) => j >= 0 ? c[j]?.trim() || '' : ''
      const invoiceRef = g(iInvoiceRef)
      const clientRef  = g(iClient)
      const amount     = g(iAmount)
      const pct        = g(iPct)
      const total      = g(iTotal)
      const reason     = g(iReason)
      const discountDate = normalizeDate(g(iDate)) || new Date().toISOString().slice(0, 10)

      // Resolve invoice_id (optional)
      const isUUID = /^[0-9a-f-]{36}$/i.test(invoiceRef)
      const invMatch = invoiceRef ? (isUUID ? { id: invoiceRef, client_id: '', total: 0 } : invMap[norm(invoiceRef)]) : null
      const invoice_id  = invMatch?.id || null
      const invoice_total_fallback = invMatch?.total || 0
      // Resolve client_id (required)
      let client_id = clientRef ? clientMap[norm(clientRef)] : (invMatch?.client_id || '')

      const r: ParsedRow = {
        ...baseRow(i), row_id: g(iId),
        invoice_ref:         invoiceRef,
        invoice_id:          invoice_id,
        client_ref:          clientRef,
        client_id:           client_id,
        discount_amount:     amount,
        discount_percentage: pct,
        invoice_total:       total || String(invoice_total_fallback),
        reason:              reason,
        discount_date:       discountDate,
      }
      if (invoiceRef && !invoice_id) r.errors.push(`Invoice "${invoiceRef}" not found in database`)
      if (!client_id) r.errors.push(`Client "${clientRef}" not found — required for discount history`)
      if (!amount && !pct) r.errors.push('Either discount_amount or discount_percentage is required')
      if (amount && isNaN(parseFloat(amount))) r.errors.push('discount_amount must be a number')
      if (pct && isNaN(parseFloat(pct))) r.errors.push('discount_percentage must be a number')
      if (r.discount_date && !/^\d{4}-\d{2}-\d{2}$/.test(r.discount_date)) r.errors.push('discount_date must be DD-MM-YYYY or YYYY-MM-DD')
      return finalize(r)
    })
  }

  // ── File handler ───────────────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    const lines = parseCSV(text)
    if (lines.length < 2) { toastError('File appears empty or has no data rows'); return }
    let parsed: ParsedRow[] = []
    switch (mode) {
      case 'employees':     parsed = parseEmployees(lines);          break
      case 'clients':       parsed = parseClients(lines);            break
      case 'services':      parsed = parseServices(lines);           break
      case 'groups':        parsed = parseGroups(lines);             break
      case 'parameters':    parsed = parseParameters(lines);         break
      case 'tools':          parsed = parseTools(lines);              break
      case 'pricing_matrix': parsed = parsePricingMatrix(lines);     break
      case 'jobs':           parsed = parseJobs(lines);              break
      case 'contributions': parsed = await parseContributions(lines); break
      case 'cashbook_entries': parsed = parseCashbookEntries(lines);        break
      case 'invoices':         parsed = parseInvoices(lines);               break
      case 'invoice_status':   parsed = await parseInvoiceStatus(lines);    break
      case 'discounts':        parsed = await parseDiscounts(lines);        break
    }
    if (operation === 'update' || operation === 'delete') {
      parsed.forEach(p => {
        if (!p.row_id) {
          p.errors.push('id is required in ' + operation + ' mode')
          p.status = 'error'
        }
      })
    }
    setRows(parsed)
    setStep('preview')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, operation, clientMap, serviceMap, empMap, groupMap, bankAccountMap, cashCategoryMap])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f) }
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }

  // ── Importers ──────────────────────────────────────────────────────────────
  async function runImport() {
    const valid = rows.filter(r => r.status !== 'error')
    if (!valid.length) { toastError('No valid rows to import'); return }
    setImporting(true)
    const res = { inserted: 0, skipped: 0, errors: [] as string[] }
    const BATCH = 50

    const batchInsert = async (table: string, records: any[], conflict?: string) => {
      for (let i = 0; i < records.length; i += BATCH) {
        const b = records.slice(i, i + BATCH)
        const q = conflict
          ? supabase.from(table).upsert(b, { onConflict: conflict }).select('id')
          : supabase.from(table).insert(b).select('id')
        const { data, error } = await q
        if (error) { res.errors.push(`Batch ${Math.floor(i/BATCH)+1}: ${error.message}`); res.skipped += b.length }
        else res.inserted += data?.length || 0
      }
    }

    const backupBeforeUpdate = async (table: string, ids: string[]) => {
      if (ids.length === 0) return
      const { data } = await supabase.from(table).select('*').in('id', ids)
      if (!data || data.length === 0) return
      const allKeys = new Set<string>()
      data.forEach((r: Record<string, unknown>) => Object.keys(r).forEach(k => allKeys.add(k)))
      const headers = ['id', ...[...allKeys].filter(k => k !== 'id').sort()]
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      downloadCsv(`backup_${mode}_${ts}.csv`, toCsv(headers, data))
    }

    const batchUpdate = async (table: string, records: { row_id: string; fields: any }[]) => {
      const UBATCH = 25
      for (let i = 0; i < records.length; i += UBATCH) {
        const batch = records.slice(i, i + UBATCH)
        await Promise.all(batch.map(async ({ row_id, fields }) => {
          const { error } = await supabase.from(table).update(fields).eq('id', row_id)
          if (error) { res.errors.push(`row ${row_id}: ${error.message}`); res.skipped += 1 }
          else { res.inserted += 1 }
        }))
      }
    }

    async function batchDelete(table: string, ids: string[]) {
      if (ids.length === 0) return
      const BATCH = 25
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH)
        const { error } = await supabase.from(table).delete().in('id', batch)
        if (error) {
          res.errors.push(`Delete batch failed: ${error.message}`)
          res.skipped += batch.length
        } else {
          res.inserted += batch.length  // reusing inserted as "processed count"
        }
      }
    }

    switch (mode) {
      case 'employees': {
        const table = 'employees'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            cqid: r.cqid, name: r.name, email: r.email, phone: r.phone || null,
            role: r.role || 'employee', salary_type: r.salary_type || 'fixed',
            base_salary: parseFloat(r.base_salary) || 0,
            performance_rating: parseFloat(r.performance_rating) || 70,
            joined_date: r.joined_date || null,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })))
        }
        break
      }
      case 'clients': {
        const table = 'clients'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            code: r.code, name: r.name, contact_name: r.contact_name || null,
            phone: r.phone || null, email: r.email || null, address: r.address || null,
            gstin: r.gstin || null, default_currency: r.default_currency || 'INR',
            billing_cycle: r.billing_cycle || 'monthly',
            billing_day: parseInt(r.billing_day) || 1,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })))
        }
        break
      }
      case 'services': {
        const table = 'services'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id:    r.row_id,
          group_ids: (r.group_ids || []) as string[],   // contribution group ids parsed from CSV
          fields: {
            name: r.name, pricing_type: r.pricing_type, description: r.description || null,
            display_order: parseInt(r.display_order) || 0,
            default_price: r.default_price ? parseFloat(r.default_price) : null,
            default_currency: r.default_currency || 'INR',
            is_active: r.is_active !== false,
          },
        }))

        // Helper: replace group_services links for one service id
        async function saveServiceGroups(serviceId: string, groupIds: string[]) {
          // Clean wipe + insert (mirrors the settings UI behaviour). Gracefully
          // ignores failures (e.g. if the group_services table doesn't exist).
          const { error: delErr } = await supabase.from('group_services').delete().eq('service_id', serviceId)
          if (delErr) return // table missing — skip silently
          if (groupIds.length > 0) {
            await supabase.from('group_services').insert(
              groupIds.map(gid => ({ group_id: gid, service_id: serviceId }))
            )
          }
        }

        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs.map(r => ({ row_id: r.row_id!, fields: r.fields })))
          // Save group links for rows that specified group_names
          for (const r of recs) {
            if (r.row_id) await saveServiceGroups(r.row_id, r.group_ids)
          }
        } else {
          // Insert one-by-one so we can capture the new service IDs and save their group links.
          // (batchInsert collapses the response, losing per-row ids.)
          for (const r of recs) {
            const { data, error } = await supabase.from(table).insert(r.fields).select('id').single()
            if (error) { res.errors.push(`Service "${r.fields.name}": ${error.message}`); res.skipped += 1; continue }
            res.inserted += 1
            if (data?.id && r.group_ids.length > 0) await saveServiceGroups(data.id, r.group_ids)
          }
        }
        break
      }
      case 'groups': {
        const table = 'contribution_groups'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            name: r.name, weight: parseFloat(r.weight), description: r.description || null,
            display_order: parseInt(r.display_order) || 0,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })))
        }
        break
      }
      case 'parameters': {
        const table = 'parameters'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            group_id: r.group_id, name: r.name, is_master: r.is_master === true,
            weight: parseFloat(r.weight) || 1,
            description: r.description || null, display_order: parseInt(r.display_order) || 0,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          const paramRows = recs.map(r => ({ ...r.fields, is_active: true }))
          // Try with is_master first; fall back without it if column doesn't exist yet
          const firstBatch = await supabase.from('parameters').insert(paramRows.slice(0, 1)).select('id')
          if (firstBatch.error?.message?.includes('is_master')) {
            // Column not in schema yet — strip is_master and import without it
            const rowsWithout = paramRows.map(({ is_master: _m, ...rest }) => rest)
            await batchInsert('parameters', rowsWithout)
            res.errors.push('⚠️ is_master column not found — run the SQL migration in Supabase to enable master parameter tracking. All other fields imported successfully.')
          } else {
            if (firstBatch.error) { res.errors.push(firstBatch.error.message); res.skipped += 1 }
            else { res.inserted += firstBatch.data?.length || 0 }
            if (paramRows.length > 1) await batchInsert('parameters', paramRows.slice(1))
          }
        }
        break
      }
      case 'tools': {
        const table = 'tools'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            name: r.name, fixed_percentage: parseFloat(r.fixed_percentage),
            group_id: r.group_id || null, description: r.description || null,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })))
        }
        break
      }
      case 'pricing_matrix': {
        const table = 'client_service_pricing'
        if (operation === 'delete') {
          // DEACTIVATE, never DELETE. A row here is both the client's service
          // commitment and its agreed price — dropping it breaks historical
          // commission recompute (lib/payroll/compute.ts). The canonical
          // predicate `is_active IS NOT FALSE` hides it everywhere, so this is
          // a removal from the user's point of view.
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          if (ids.length > 0) {
            await supabase.from(table)
              .update({ is_active: false, deactivated_at: new Date().toISOString() })
              .in('id', ids)
          }
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            client_id: r.client_id,
            service_id: r.service_id,
            price: r.price ? parseFloat(r.price) : null,
            percentage_rate: r.percentage_rate ? parseFloat(r.percentage_rate) : null,
            commission_percentage: parseFloat(r.commission_percentage) || 0,
            currency: (r.currency || 'INR').toUpperCase(),
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id))
          await batchUpdate(table, recs)
        } else {
          await batchInsert(table, recs.map(r => ({ ...r.fields, is_active: true })), 'client_id,service_id')
        }
        break
      }
      case 'jobs': {
        const table = 'tasks'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        if (operation === 'update') {
          // In update mode, respect the CSV's task_number as-is (no auto-assign)
          const recs = valid.map(r => {
            const fields: any = {
              title: r.title, description: r.description || null,
              client_id: r.client_id || null, service_id: r.service_id || null,
              task_date: r.task_date,
              billing_amount_inr: parseFloat(r.billing_amount_inr) || 0,
              billing_amount: parseFloat(r.billing_amount) || parseFloat(r.billing_amount_inr) || 0,
              currency: r.currency || 'INR',
              quantity: parseFloat(r.quantity) || 1,
              status: r.task_status || 'done',
              is_recurring: r.is_recurring || false,
              recurring_interval: r.recurring_interval || null,
              recurring_end_date: r.recurring_end_date || null,
            }
            if (r.task_number && /^\d+$/.test(r.task_number)) {
              fields.task_number = parseInt(r.task_number, 10)
            }
            return { row_id: r.row_id, fields }
          })
          await backupBeforeUpdate('tasks', recs.map(r => r.row_id))
          await batchUpdate('tasks', recs)
        } else {
          // Base columns guaranteed to exist in schema
          const baseRows = valid.map(r => ({
            title: r.title,
            description: r.description || null,
            client_id: r.client_id || null,
            service_id: r.service_id || null,
            task_date: r.task_date,
            billing_amount_inr: parseFloat(r.billing_amount_inr) || 0,
            billing_amount: parseFloat(r.billing_amount) || parseFloat(r.billing_amount_inr) || 0,
            currency: r.currency || 'INR',
            status: r.task_status || 'done',
          }))

          // Extended columns added by migration 003 (may not exist on older deployments)
          const extendedRows = valid.map((r, i) => ({
            ...baseRows[i],
            ...(r.task_number && /^\d+$/.test(r.task_number) ? { task_number: parseInt(r.task_number, 10) } : {}),
            quantity: parseFloat(r.quantity) || 1,
            is_recurring: r.is_recurring || false,
            recurring_interval: r.recurring_interval || null,
            recurring_end_date: r.recurring_end_date || null,
          }))

          // Probe with a single extended row — fall back to base-only on any schema error
          const probe = await supabase.from('tasks').insert([extendedRows[0]]).select('id')
          const schemaError = probe.error?.message?.includes('column') || probe.error?.message?.includes('schema cache')
          if (schemaError) {
            // One or more new columns missing — import without them and warn once
            res.errors.push('⚠️ Some task columns (task_number / quantity / is_recurring) not found in schema. Run migrations/003_tasks_import_columns.sql in Supabase. Importing base fields only.')
            await batchInsert('tasks', baseRows)
          } else {
            // Extended columns exist — count probe row and import the rest
            if (probe.error) { res.errors.push(`Batch 1: ${probe.error.message}`); res.skipped += 1 }
            else { res.inserted += probe.data?.length || 0 }
            if (extendedRows.length > 1) await batchInsert('tasks', extendedRows.slice(1))
          }
        }
        break
      }
      case 'contributions': {
        const table = 'contribution_scores'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        if (operation === 'update') {
          // Simple update path: update contribution_scores directly by id
          const recs = valid.map(r => ({
            row_id: r.row_id,
            fields: {
              task_id: r.task_id || null,
              employee_id: r.employee_id,
              score_percentage: parseFloat(r.score_percentage) || 0,
              earnings_inr: parseFloat(r.earnings) || 0,
              calculated_at: new Date().toISOString(),
            },
          }))
          await backupBeforeUpdate('contribution_scores', recs.map(r => r.row_id))
          await batchUpdate('contribution_scores', recs)
        } else if (contribSubMode === 'earnings_only') {
          // Store earnings directly, score_percentage = 0 (unknown)
          await batchInsert('contribution_scores', valid.map(r => ({
            task_id: r.task_id || null,
            employee_id: r.employee_id,
            score_percentage: 0,
            earnings_inr: parseFloat(r.earnings) || 0,
            calculated_at: new Date().toISOString(),
          })), 'task_id,employee_id')
        } else if (contribSubMode === 'score_pct') {
          // Store score + earnings (earnings may be blank → 0)
          await batchInsert('contribution_scores', valid.map(r => ({
            task_id: r.task_id || null,
            employee_id: r.employee_id,
            score_percentage: parseFloat(r.score_percentage) || 0,
            earnings_inr: parseFloat(r.earnings) || 0,
            calculated_at: new Date().toISOString(),
          })), 'task_id,employee_id')
        } else {
          // param_detail — insert into contributions table (parameter-level values)
          const contribRows: any[] = []
          for (const r of valid) {
            for (const [paramId, rawVal] of Object.entries(r._paramValues as Record<string, string>)) {
              const val = parseFloat(rawVal) || 0
              if (val > 0) {  // only insert non-zero values
                contribRows.push({
                  task_id: r.task_id || null,
                  employee_id: r.employee_id,
                  parameter_id: paramId,
                  value: val,
                  locked: false,
                })
              }
            }
          }
          if (contribRows.length) {
            await batchInsert('contributions', contribRows)
          }
        }
        break
      }

      case 'cashbook_entries': {
        const table = 'cashbook_entries'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            entry_date:      r.entry_date,
            type:            r.type,
            category_id:     r.category_id || null,
            bank_account_id: r.bank_account_id || null,
            amount:          parseFloat(r.amount) || 0,
            currency:        r.currency || 'INR',
            amount_inr:      parseFloat(r.amount_inr || r.amount) || 0,
            description:     r.description || null,
            reference:       r.reference || null,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id).filter(Boolean) as string[])
          await batchUpdate(table, recs.filter(r => r.row_id) as any)
        } else {
          await batchInsert(table, recs.map(r => r.fields))
        }
        break
      }

      case 'invoices': {
        const table = 'invoices'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => ({
          row_id: r.row_id,
          fields: {
            invoice_number:       r.invoice_number,
            client_id:            r.client_id,
            issue_date:           r.issue_date,
            due_date:             r.due_date || null,
            billing_period_start: r.billing_period_start || null,
            billing_period_end:   r.billing_period_end   || null,
            currency:             r.currency || 'INR',
            subtotal:             parseFloat(r.subtotal) || 0,
            total_amount:         parseFloat(r.subtotal) || 0,
            tax_rate:             parseFloat(r.tax_rate) || 0,
            tax_amount:           0,
            discount_amount:      parseFloat(r.discount_amount) || 0,
            status:               r.invoice_status || 'draft',
            notes:                r.notes || null,
          },
        }))
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id).filter(Boolean) as string[])
          await batchUpdate(table, recs.filter(r => r.row_id) as any)
        } else {
          await batchInsert(table, recs.map(r => r.fields))
        }
        break
      }

      case 'discounts': {
        const table = 'discount_logs'
        if (operation === 'delete') {
          const ids = valid.map(r => r.row_id).filter(Boolean) as string[]
          await backupBeforeUpdate(table, ids)
          await batchDelete(table, ids)
          break
        }
        const recs = valid.map(r => {
          const amount = parseFloat(r.discount_amount) || 0
          const pct    = parseFloat(r.discount_percentage) || 0
          const total  = parseFloat(r.invoice_total) || 0
          // Derive whichever wasn't provided
          let finalAmount     = amount
          let finalPercentage = pct
          if (!finalAmount && finalPercentage && total > 0)     finalAmount     = (finalPercentage / 100) * total
          if (!finalPercentage && finalAmount && total > 0)     finalPercentage = (finalAmount   / total) * 100
          return {
            row_id: r.row_id,
            fields: {
              invoice_id:          r.invoice_id || null,
              client_id:           r.client_id,
              discount_amount:     finalAmount,
              discount_percentage: finalPercentage,
              invoice_total:       total,
              reason:              r.reason || 'Bulk import',
              created_at:          r.discount_date ? new Date(r.discount_date).toISOString() : new Date().toISOString(),
            },
          }
        })
        if (operation === 'update') {
          await backupBeforeUpdate(table, recs.map(r => r.row_id).filter(Boolean) as string[])
          await batchUpdate(table, recs.filter(r => r.row_id) as any)
        } else {
          await batchInsert(table, recs.map(r => r.fields))
        }
        break
      }

      case 'invoice_status': {
        // Special: update invoice status + optionally insert a payment record
        for (const r of valid) {
          const invId = r.invoice_id
          if (!invId) { res.skipped += 1; continue }
          const updateFields: any = { status: r.invoice_status }
          if (r.paid_amount) updateFields.paid_amount = parseFloat(r.paid_amount)
          const { error: updErr } = await supabase.from('invoices').update(updateFields).eq('id', invId)
          if (updErr) { res.errors.push(`${r.invoice_ref}: ${updErr.message}`); res.skipped += 1; continue }
          // Optionally insert payment record
          if (r.paid_amount && parseFloat(r.paid_amount) > 0) {
            await supabase.from('invoice_payments').insert({
              invoice_id: invId,
              amount: parseFloat(r.paid_amount),
              payment_date: r.payment_date || new Date().toISOString().slice(0, 10),
              payment_method: r.payment_method || 'other',
              notes: r.notes || null,
            }).select('id')
          }
          res.inserted += 1
        }
        break
      }
    }

    setResult(res)
    setImporting(false)
    setStep('done')
    if (res.inserted > 0) success(`${res.inserted} records ${operation === 'update' ? 'updated' : operation === 'delete' ? 'deleted' : 'imported'} successfully`)
    if (res.errors.length) toastError(`${res.errors.length} batch error(s)`)
  }

  function reset() { setStep('upload'); setRows([]); setResult(null); if (fileRef.current) fileRef.current.value = '' }

  // ── Clean-up helpers ───────────────────────────────────────────────────────
  const TABLE_FOR_MODE: Record<ImportMode, string> = {
    employees:        'employees',
    clients:          'clients',
    services:         'services',
    groups:           'contribution_groups',
    parameters:       'parameters',
    tools:            'tools',
    pricing_matrix:   'client_service_pricing',
    jobs:             'tasks',
    contributions:    'contribution_scores',
    cashbook_entries: 'cashbook_entries',
    invoices:         'invoices',
    invoice_status:   'invoices',
    discounts:        'discount_logs',
  }

  async function loadCleanupRecords(m: ImportMode) {
    setCleanupLoading(true)
    setSelectedIds(new Set())
    setCleanupRecords([])
    const table = TABLE_FOR_MODE[m]
    let q: any

    if (m === 'parameters') {
      q = supabase.from('parameters')
        .select('id, name, weight, is_active, display_order, contribution_groups(name)')
        .order('display_order')
    } else if (m === 'tools') {
      q = supabase.from('tools')
        .select('id, name, fixed_percentage, is_active, contribution_groups(name)')
        .order('name')
    } else if (m === 'pricing_matrix') {
      q = supabase.from('client_service_pricing')
        .select('id, price, percentage_rate, commission_percentage, currency, is_active, clients(name, code), services(name)')
        .order('created_at', { ascending: false })
    } else if (m === 'jobs') {
      q = supabase.from('tasks')
        .select('id, title, task_date, status, billing_amount_inr, clients(name)')
        .order('task_date', { ascending: false })
        .limit(500)
    } else if (m === 'contributions') {
      q = supabase.from('contribution_scores')
        .select('id, score_percentage, earnings_inr, calculated_at, tasks(title, task_date), employees(name, cqid)')
        .order('calculated_at', { ascending: false })
        .limit(500)
    } else {
      q = supabase.from(table).select('*').order('created_at', { ascending: false })
    }

    const { data, error } = await q
    if (error) { toastError(`Failed to load: ${error.message}`); setCleanupLoading(false); return }
    setCleanupRecords(data || [])
    setCleanupLoading(false)
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === cleanupRecords.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(cleanupRecords.map((r: any) => r.id)))
    }
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]

    // Warn about cascade for certain entity types
    const cascadeWarnings: Record<string, string> = {
      parameters:    'Contributions referencing these parameters will also be deleted.',
      jobs:          'Invoice items, contributions, and contribution scores for these tasks will also be deleted.',
      employees:     'Contribution scores for these employees will also be deleted.',
      groups:        'All parameters (and their contributions) inside these groups will also be deleted.',
    }
    const extraWarning = cascadeWarnings[cleanupMode] ? `\n\n⚠️ ${cascadeWarnings[cleanupMode]}` : ''
    if (!window.confirm(`Delete ${ids.length} record${ids.length !== 1 ? 's' : ''}? This cannot be undone.${extraWarning}`)) return

    setDeleting(true)
    const BATCH = 100

    const batchDelete = async (table: string, field: string, values: string[]) => {
      for (let i = 0; i < values.length; i += BATCH) {
        const { error } = await supabase.from(table).delete().in(field, values.slice(i, i + BATCH))
        if (error) throw new Error(`${table}: ${error.message}`)
      }
    }

    try {
      // ── Cascade deletes before the main delete ──────────────────────────────
      if (cleanupMode === 'parameters') {
        // Delete contributions that use these parameters
        await batchDelete('contributions', 'parameter_id', ids)
      }
      if (cleanupMode === 'groups') {
        // Find all parameter IDs in these groups, then cascade
        const { data: paramRows } = await supabase.from('parameters').select('id').in('group_id', ids)
        const paramIds = (paramRows || []).map((p: any) => p.id)
        if (paramIds.length) {
          await batchDelete('contributions', 'parameter_id', paramIds)
          await batchDelete('parameters', 'id', paramIds)
        }
      }
      if (cleanupMode === 'jobs') {
        // Delete invoice_items referencing these tasks (FK: invoice_items_task_id_fkey)
        await batchDelete('invoice_items', 'task_id', ids)
        // Delete contribution_scores for these tasks
        await batchDelete('contribution_scores', 'task_id', ids)
        await batchDelete('contributions', 'task_id', ids)
      }
      if (cleanupMode === 'employees') {
        // Delete contribution_scores for these employees
        await batchDelete('contribution_scores', 'employee_id', ids)
        await batchDelete('contributions', 'employee_id', ids)
      }

      // ── Main delete ─────────────────────────────────────────────────────────
      await batchDelete(TABLE_FOR_MODE[cleanupMode], 'id', ids)

      setDeleting(false)
      success(`${ids.length} record${ids.length !== 1 ? 's' : ''} deleted`)
      await loadCleanupRecords(cleanupMode)
    } catch (err: any) {
      setDeleting(false)
      toastError(`Delete failed: ${err.message}`)
    }
  }

  // ── Clean-up table ─────────────────────────────────────────────────────────
  function renderCleanupTable() {
    const thCls = 'px-3 py-2 text-left text-muted-foreground text-[11px] font-semibold'
    const tdCls = 'px-3 py-2 text-xs'
    const allSelected = cleanupRecords.length > 0 && selectedIds.size === cleanupRecords.length

    const CheckTh = () => (
      <th className="px-3 py-2 w-8">
        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
          className="accent-violet-500 w-3.5 h-3.5" />
      </th>
    )
    const CheckTd = ({ id }: { id: string }) => (
      <td className="px-3 py-2">
        <input type="checkbox" checked={selectedIds.has(id)} onChange={() => toggleSelect(id)}
          className="accent-violet-500 w-3.5 h-3.5" />
      </td>
    )
    const selCls = (id: string) => `border-b border-border/40 ${selectedIds.has(id) ? 'bg-violet-500/10' : ''}`

    if (cleanupMode === 'employees') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>CQID</th><th className={thCls}>Name</th>
        <th className={thCls}>Email</th><th className={thCls}>Role</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-mono text-violet-300'}>{r.cqid}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.email}</td>
          <td className={tdCls}>{r.role}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'clients') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Code</th><th className={thCls}>Name</th>
        <th className={thCls}>Contact</th><th className={thCls}>Phone</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-mono text-violet-300'}>{r.code}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.contact_name || '—'}</td>
          <td className={tdCls}>{r.phone || '—'}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'services') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Name</th><th className={thCls}>Pricing Type</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.pricing_type}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'groups') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Name</th><th className={thCls}>Weight</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/><td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'parameters') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Group</th><th className={thCls}>Parameter Name</th>
        <th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.contribution_groups as any)?.name || '—'}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'tools') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Tool Name</th><th className={thCls}>Fixed %</th>
        <th className={thCls}>Group</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.fixed_percentage}%</td>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.contribution_groups as any)?.name || '—'}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'pricing_matrix') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls+' text-right'}>Price</th><th className={thCls+' text-right'}>Rate%</th>
        <th className={thCls+' text-right'}>Commission%</th><th className={thCls}>Currency</th><th className={thCls}>Active</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium'}>{(r.clients as any)?.name || '—'}</td>
          <td className={tdCls+' text-muted-foreground'}>{(r.services as any)?.name || '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.price ? `₹${Number(r.price).toLocaleString('en-IN')}` : '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.percentage_rate ? `${r.percentage_rate}%` : '—'}</td>
          <td className={tdCls+' text-right font-mono text-violet-300'}>{r.commission_percentage}%</td>
          <td className={tdCls}>{r.currency}</td>
          <td className={tdCls}>{r.is_active ? <span className="text-green-400 text-[10px]">Active</span> : <span className="text-red-400 text-[10px]">Inactive</span>}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'jobs') return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Title</th><th className={thCls}>Client</th>
        <th className={thCls}>Date</th><th className={thCls}>Amount</th><th className={thCls}>Status</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-medium max-w-[160px] truncate'} title={r.title}>{r.title}</td>
          <td className={tdCls+' text-muted-foreground text-[11px]'}>{(r.clients as any)?.name || '—'}</td>
          <td className={tdCls+' font-mono text-[11px]'}>{r.task_date}</td>
          <td className={tdCls+' font-mono text-right'}>{r.billing_amount_inr ? `₹${Number(r.billing_amount_inr).toLocaleString('en-IN')}` : '—'}</td>
          <td className={tdCls}><span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${r.status === 'done' ? 'bg-green-500/15 text-green-400' : r.status === 'pending' ? 'bg-yellow-500/15 text-yellow-400' : 'bg-blue-500/15 text-blue-400'}`}>{r.status}</span></td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'cashbook_entries') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Date</th><th className={thCls}>Type</th>
        <th className={thCls}>Description</th><th className={thCls+' text-right'}>Amount</th><th className={thCls}>Currency</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-mono'}>{r.entry_date}</td>
          <td className={tdCls}><span className={r.type==='inflow'?'text-green-400':'text-red-400'}>{r.type}</span></td>
          <td className={tdCls+' max-w-[200px] truncate'} title={r.description}>{r.description || '—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.amount?.toLocaleString('en-IN')}</td>
          <td className={tdCls}>{r.currency}</td>
        </tr>))}</tbody></table>
    )

    if (cleanupMode === 'invoices') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Invoice #</th><th className={thCls}>Issue Date</th>
        <th className={thCls}>Status</th><th className={thCls+' text-right'}>Total</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' font-mono text-violet-300'}>{r.invoice_number}</td>
          <td className={tdCls+' font-mono'}>{r.issue_date}</td>
          <td className={tdCls}>{r.status}</td>
          <td className={tdCls+' text-right font-mono'}>₹{r.total_amount?.toLocaleString('en-IN')}</td>
        </tr>))}</tbody></table>
    )

    // contributions
    return (
      <table className="w-full"><thead><tr className="border-b border-border bg-background/40">
        <CheckTh/><th className={thCls}>Task</th><th className={thCls}>Date</th>
        <th className={thCls}>Employee</th><th className={thCls}>Score %</th><th className={thCls}>Earnings</th>
      </tr></thead><tbody>{cleanupRecords.map((r: any) => (
        <tr key={r.id} className={selCls(r.id)} onClick={() => toggleSelect(r.id)}>
          <CheckTd id={r.id}/>
          <td className={tdCls+' max-w-[140px] truncate'} title={(r.tasks as any)?.title}>{(r.tasks as any)?.title || '—'}</td>
          <td className={tdCls+' font-mono text-[11px]'}>{(r.tasks as any)?.task_date || '—'}</td>
          <td className={tdCls}>{(r.employees as any)?.cqid} · {(r.employees as any)?.name}</td>
          <td className={tdCls+' text-right font-mono'}>{r.score_percentage}%</td>
          <td className={tdCls+' text-right font-mono'}>{r.earnings_inr ? `₹${Number(r.earnings_inr).toLocaleString('en-IN')}` : '—'}</td>
        </tr>))}</tbody></table>
    )
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const okCount    = rows.filter(r => r.status === 'ok').length
  const warnCount  = rows.filter(r => r.status === 'warn').length
  const errorCount = rows.filter(r => r.status === 'error').length

  // ── Preview table ──────────────────────────────────────────────────────────
  function renderPreviewTable() {
    const thCls = 'px-3 py-2 text-left text-muted-foreground'
    const tdCls = 'px-3 py-2'

    if (mode === 'employees') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>CQID</th>
        <th className={thCls}>Name</th><th className={thCls}>Email</th><th className={thCls}>Role</th>
        <th className={thCls}>Salary Type</th><th className={thCls}>Base ₹</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.cqid}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.email}</td>
          <td className={tdCls}>{r.role}</td>
          <td className={tdCls}>{r.salary_type}</td>
          <td className={tdCls+' text-right font-mono'}>{r.base_salary ? `₹${parseFloat(r.base_salary).toLocaleString('en-IN')}` : '—'}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'clients') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Code</th>
        <th className={thCls}>Name</th><th className={thCls}>Contact</th>
        <th className={thCls}>Phone</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.code}</td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls+' text-muted-foreground'}>{r.contact_name}</td>
          <td className={tdCls}>{r.phone}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'services') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Name</th>
        <th className={thCls}>Pricing Type</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.pricing_type}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'groups') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Name</th>
        <th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'parameters') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Group</th>
        <th className={thCls}>Parameter Name</th><th className={thCls}>Master?</th><th className={thCls}>Weight</th><th className={thCls}>Order</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.group_id ? <span className="text-green-400">{r.group_name}</span> : <span className="text-red-400">{r.group_name}</span>}</td>
          <td className={tdCls+' font-medium'}>{r.name || <span className="text-red-400 italic">missing</span>}</td>
          <td className={tdCls+' text-center'}>{r.is_master ? <span className="text-violet-400 font-semibold">✓</span> : <span className="text-muted-foreground/40">—</span>}</td>
          <td className={tdCls}>{r.weight}</td>
          <td className={tdCls}>{r.display_order}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'tools') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Tool Name</th>
        <th className={thCls}>Fixed %</th><th className={thCls}>Group</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium'}>{r.name}</td>
          <td className={tdCls}>{r.fixed_percentage}%</td>
          <td className={tdCls}>{r.group_id ? <span className="text-green-400">{r.group_name}</span> : <span className="text-muted-foreground/50">{r.group_name || '—'}</span>}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'pricing_matrix') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th>
        <th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls+' text-right'}>Price</th><th className={thCls+' text-right'}>Rate%</th>
        <th className={thCls+' text-right'}>Commission%</th><th className={thCls}>Currency</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:<span className="text-red-400">{r.client_ref}</span>}</td>
          <td className={tdCls}>{r.service_id?<span className="text-green-400">{r.service_ref}</span>:<span className="text-red-400">{r.service_ref}</span>}</td>
          <td className={tdCls+' text-right font-mono'}>{r.price?`₹${parseFloat(r.price).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' text-right font-mono'}>{r.percentage_rate?`${r.percentage_rate}%`:'—'}</td>
          <td className={tdCls+' text-right font-mono text-violet-300'}>{r.commission_percentage?`${r.commission_percentage}%`:'—'}</td>
          <td className={tdCls}>{r.currency}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'jobs') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Title</th>
        <th className={thCls}>Client</th><th className={thCls}>Service</th>
        <th className={thCls}>Date</th><th className={thCls}>Amount</th><th className={thCls}>Status</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-medium max-w-[150px] truncate'} title={r.title}>{r.title}</td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:r.client_ref?<span className="text-yellow-400">{r.client_ref}</span>:'—'}</td>
          <td className={tdCls}>{r.service_id?<span className="text-green-400">{r.service_ref}</span>:r.service_ref?<span className="text-yellow-400">{r.service_ref}</span>:'—'}</td>
          <td className={tdCls+' font-mono'}>{r.task_date}</td>
          <td className={tdCls+' text-right font-mono'}>{r.billing_amount_inr?`₹${parseFloat(r.billing_amount_inr).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls}>{r.task_status}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'cashbook_entries') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Date</th>
        <th className={thCls}>Type</th><th className={thCls}>Category</th><th className={thCls}>Bank Account</th>
        <th className={thCls+' text-right'}>Amount</th><th className={thCls}>Currency</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono'}>{r.entry_date}</td>
          <td className={tdCls}><span className={r.type==='inflow'?'text-green-400':'text-red-400'}>{r.type}</span></td>
          <td className={tdCls}>{r.category_id?<span className="text-green-400">{r.category_name}</span>:<span className="text-muted-foreground/50">{r.category_name||'—'}</span>}</td>
          <td className={tdCls}>{r.bank_account_id?<span className="text-green-400">{r.bank_account_name}</span>:<span className="text-muted-foreground/50">{r.bank_account_name||'—'}</span>}</td>
          <td className={tdCls+' text-right font-mono'}>{r.amount?parseFloat(r.amount).toLocaleString('en-IN'):'—'}</td>
          <td className={tdCls}>{r.currency}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'invoices') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Invoice #</th>
        <th className={thCls}>Client</th><th className={thCls}>Issue Date</th>
        <th className={thCls+' text-right'}>Subtotal</th><th className={thCls}>Status</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls+' font-mono text-violet-300'}>{r.invoice_number}</td>
          <td className={tdCls}>{r.client_id?<span className="text-green-400">{r.client_ref}</span>:<span className="text-red-400">{r.client_ref||'missing'}</span>}</td>
          <td className={tdCls+' font-mono'}>{r.issue_date}</td>
          <td className={tdCls+' text-right font-mono'}>{r.subtotal?`₹${parseFloat(r.subtotal).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls}>{r.invoice_status}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    if (mode === 'invoice_status') return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Invoice Ref</th>
        <th className={thCls}>New Status</th><th className={thCls+' text-right'}>Paid Amount</th>
        <th className={thCls}>Payment Date</th><th className={thCls}>Method</th><th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.invoice_id?<span className="text-green-400">{r.invoice_ref}</span>:<span className="text-red-400">{r.invoice_ref||'missing'}</span>}</td>
          <td className={tdCls}>{r.invoice_status}</td>
          <td className={tdCls+' text-right font-mono'}>{r.paid_amount?`₹${parseFloat(r.paid_amount).toLocaleString('en-IN')}`:'—'}</td>
          <td className={tdCls+' font-mono'}>{r.payment_date||'—'}</td>
          <td className={tdCls}>{r.payment_method||'—'}</td>
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )

    // contributions
    const visibleParams = contribSubMode === 'param_detail' ? parameters.slice(0, 6) : []
    return (
      <table className="w-full text-xs"><thead><tr className="border-b border-border bg-background/40">
        <th className={thCls}>#</th><th className={thCls}>St</th><th className={thCls}>Task</th>
        <th className={thCls}>Date</th><th className={thCls}>CQID</th>
        {contribSubMode === 'earnings_only' && <th className={thCls+' text-right'}>Earnings</th>}
        {contribSubMode === 'score_pct' && <><th className={thCls+' text-right'}>Score %</th><th className={thCls+' text-right'}>Earnings</th></>}
        {contribSubMode === 'param_detail' && visibleParams.map(p => <th key={p.id} className={thCls+' text-right max-w-[70px] truncate'} title={p.name}>{p.name.length > 8 ? p.name.slice(0, 7)+'…' : p.name}</th>)}
        <th className={thCls}>Issues</th>
      </tr></thead><tbody>{rows.map(r => (
        <tr key={r._line} className={`border-b border-border/40 ${r.status==='error'?'bg-red-500/5':r.status==='warn'?'bg-yellow-500/5':''}`}>
          <td className={tdCls+' text-muted-foreground'}>{r._line}</td>
          <td className={tdCls}><StatusBadge status={r.status}/></td>
          <td className={tdCls}>{r.task_id?<span className="text-green-400 truncate block max-w-[120px]">{r.task_ref || r.task_id_direct}</span>:<span className={r.task_ref?'text-yellow-400':'text-red-400'}>{r.task_ref||'—'}</span>}</td>
          <td className={tdCls+' font-mono'}>{r.task_date}</td>
          <td className={tdCls}>{r.employee_id?<span className="text-green-400">{r.employee_cqid}</span>:<span className="text-red-400">{r.employee_cqid||'—'}</span>}</td>
          {contribSubMode === 'earnings_only' && <td className={tdCls+' text-right font-mono'}>{r.earnings?`₹${parseFloat(r.earnings).toLocaleString('en-IN')}`:'—'}</td>}
          {contribSubMode === 'score_pct' && <><td className={tdCls+' text-right font-mono'}>{r.score_percentage?`${r.score_percentage}%`:'—'}</td><td className={tdCls+' text-right font-mono'}>{r.earnings?`₹${parseFloat(r.earnings).toLocaleString('en-IN')}`:'—'}</td></>}
          {contribSubMode === 'param_detail' && visibleParams.map(p => <td key={p.id} className={tdCls+' text-right font-mono text-[10px]'}>{(r._paramValues as any)?.[p.id] || '—'}</td>)}
          <IssueCell row={r}/>
        </tr>))}</tbody></table>
    )
  }

  // ── Reference panel ────────────────────────────────────────────────────────
  function renderReference() {
    const items: { label: string; values: string[] }[] = []
    if (['jobs', 'contributions', 'pricing_matrix'].includes(mode)) {
      items.push({ label: `Clients (${clients.length})`, values: clients.map(c => `${c.code} — ${c.name}`) })
      items.push({ label: `Services (${services.length})`, values: services.map(s => s.name) })
    }
    if (mode === 'contributions' || mode === 'jobs') {
      items.push({ label: `Employee CQIDs (${employees.length})`, values: employees.map(e => e.cqid) })
    }
    if (mode === 'parameters' || mode === 'tools') {
      items.push({ label: `Groups (${groups.length})`, values: groups.map(g => g.name) })
    }
    if (!items.length) return null
    return (
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold">Quick reference</p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          {items.map(({ label, values }) => (
            <div key={label}>
              <p className="text-muted-foreground mb-1">{label}</p>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {values.map((v, i) => <div key={i} className="font-mono text-[11px] text-foreground/70">{v}</div>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      {/* Header. pl-12 on mobile clears the fixed global sidebar hamburger
          (top-left, 16-52px) that would otherwise cover 'Bulk Import'. */}
      <div className="flex items-start justify-between gap-4 pl-12 md:pl-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bulk Import</h1>
          <p className="text-sm text-muted-foreground mt-1">Import data or clean up incorrectly added records</p>
        </div>
        {/* Page tab switcher */}
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1 shrink-0">
          <button
            onClick={() => setPageTab('import')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${pageTab === 'import' ? 'bg-violet-600 text-white shadow' : 'text-muted-foreground hover:text-foreground'}`}
          >
            📥 Import
          </button>
          <button
            onClick={() => { setPageTab('cleanup'); loadCleanupRecords(cleanupMode) }}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${pageTab === 'cleanup' ? 'bg-red-600 text-white shadow' : 'text-muted-foreground hover:text-foreground'}`}
          >
            🗑️ Clean Up
          </button>
        </div>
      </div>

      {/* Mode selector — tiered for import, flat for cleanup */}
      <div className="space-y-3">
        {pageTab === 'import' ? (
          IMPORT_TIERS.map(tier => {
            const tierModes = MODES.filter(m => tier.modes.includes(m.key))
            const tierColors: Record<string, string> = {
              emerald: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
              blue:    'text-blue-400 border-blue-500/20 bg-blue-500/5',
              amber:   'text-amber-400 border-amber-500/20 bg-amber-500/5',
              violet:  'text-violet-400 border-violet-500/20 bg-violet-500/5',
            }
            const activeColor: Record<string, string> = {
              emerald: 'bg-emerald-600',
              blue:    'bg-blue-600',
              amber:   'bg-amber-600',
              violet:  'bg-violet-600',
            }
            return (
              <div key={tier.tier} className={`rounded-xl border p-3 space-y-2 ${tierColors[tier.color]}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-current/10 ${tierColors[tier.color].split(' ')[0]}`}>
                    Tier {tier.tier}
                  </span>
                  <span className={`text-xs font-semibold ${tierColors[tier.color].split(' ')[0]}`}>{tier.label}</span>
                  <span className="text-[11px] text-muted-foreground/60">— {tier.hint}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tierModes.map(({ key, label, emoji }) => (
                    <button
                      key={key}
                      onClick={() => { setMode(key); reset() }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                        mode === key
                          ? `${activeColor[tier.color]} text-white shadow`
                          : 'bg-background border border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span>{emoji}</span><span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {MODES.map(({ key, label, emoji }) => (
              <button
                key={key}
                onClick={() => { setCleanupMode(key); loadCleanupRecords(key) }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  cleanupMode === key
                    ? 'bg-red-600 text-white shadow'
                    : 'bg-card border border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>{emoji}</span><span>{label}</span>
              </button>
            ))}
          </div>
        )}
        {pageTab === 'cleanup' && (
          <p className="text-[11px] text-red-400">⚠️ Deletion is permanent and cannot be undone. Select records carefully before deleting.</p>
        )}
      </div>

      {/* ── CLEAN UP ────────────────────────────────────────────────────────── */}
      {pageTab === 'cleanup' && (
        <div className="space-y-3">
          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-muted-foreground">
              {cleanupLoading ? 'Loading…' : `${cleanupRecords.length} records`}
            </span>
            {selectedIds.size > 0 && (
              <span className="text-[12px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">
                {selectedIds.size} selected
              </span>
            )}
            <div className="flex-1"/>
            <button
              onClick={() => loadCleanupRecords(cleanupMode)}
              disabled={cleanupLoading}
              className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              ↻ Refresh
            </button>
            {selectedIds.size > 0 && (
              <button
                onClick={deleteSelected}
                disabled={deleting}
                className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {deleting ? 'Deleting…' : `🗑️ Delete ${selectedIds.size} selected`}
              </button>
            )}
          </div>

          {/* Table */}
          {cleanupLoading ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground text-sm">Loading records…</div>
          ) : cleanupRecords.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground text-sm">
              No records found for {MODES.find(m => m.key === cleanupMode)?.label}
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto overflow-y-auto max-h-[60vh] cursor-pointer">
                {renderCleanupTable()}
              </div>
            </div>
          )}

          {/* Tip */}
          <p className="text-[11px] text-muted-foreground">Click a row or the checkbox to select. Click row again to deselect.</p>
        </div>
      )}

      {/* ── UPLOAD ──────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'upload' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Drop zone + operation toggle */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Operation:</span>
              <div className="flex items-center border border-foreground/15 rounded-lg overflow-hidden h-[30px]">
                <button onClick={() => setOperation('insert')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors h-full ${operation === 'insert' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  + Insert new
                </button>
                <button onClick={() => setOperation('update')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors border-l border-foreground/15 h-full ${operation === 'update' ? 'bg-amber-500/15 text-amber-300' : 'text-muted-foreground hover:text-foreground'}`}>
                  ✎ Update existing
                </button>
                <button onClick={() => setOperation('delete')} className={`px-3 text-xs flex items-center gap-1.5 transition-colors border-l border-foreground/15 ${operation === 'delete' ? 'bg-red-500/15 text-red-300' : 'text-muted-foreground hover:text-foreground'}`}>
                  🗑 Delete
                </button>
              </div>
              {operation === 'update' && (
                <span className="text-[10px] text-amber-400/80 ml-2">
                  Requires <code className="font-mono">id</code> column. Auto-backs up before applying.
                </span>
              )}
              {operation === 'delete' && (
                <span className="text-[10px] text-red-400/80 ml-2">
                  ⚠ Destructive. Requires <code className="font-mono">id</code> column. Backup auto-downloaded before delete. Only the <code className="font-mono">id</code> column is read.
                </span>
              )}
            </div>
            <div
              onDrop={onDrop} onDragOver={e => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center gap-4 text-center cursor-pointer hover:border-violet-500/60 transition-colors bg-card"
            >
              <div className="w-12 h-12 rounded-full bg-violet-500/15 flex items-center justify-center text-2xl">
                {MODES.find(m => m.key === mode)?.emoji}
              </div>
              <div>
                <p className="font-semibold">Drop CSV here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">UTF-8 CSV · max 10 000 rows</p>
              </div>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileChange} />
            </div>
          </div>

          {/* Template + columns */}
          <div className="space-y-3">
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold mb-2">1. Download the template</p>
              <button
                onClick={() => downloadTemplate(mode)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-300 text-sm font-medium hover:bg-violet-600/30 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                Download {MODES.find(m => m.key === mode)?.label} Template
              </button>
              <div className="mt-2 flex">
                <button
                  type="button"
                  onClick={() => exportCurrentData(mode)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-foreground/15 text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors"
                  title="Download a CSV of current data — use this as a backup or to edit existing rows"
                >
                  <Download className="w-3 h-3" /> Export current data
                </button>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold mb-2">Columns</p>
              <table className="w-full text-left">
                <thead><tr className="text-[10px] text-muted-foreground border-b border-border">
                  <th className="pb-1 pr-2">Column</th><th className="pb-1 pr-2 text-center">Req</th><th className="pb-1">Notes</th>
                </tr></thead>
                <tbody>
                  {COLUMNS[mode].map(({ col, req, notes }) => (
                    <tr key={col} className="border-b border-border/30">
                      <td className="py-1 pr-2 font-mono text-[11px] text-violet-300">{col}</td>
                      <td className="py-1 pr-2 text-center text-[11px]">{req ? '✓' : ''}</td>
                      <td className="py-1 text-[11px] text-muted-foreground">{notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Contribution sub-mode selector */}
            {mode === 'contributions' && (
              <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold">What data do you have?</p>
                {([
                  { key: 'score_pct',     label: 'Score % per employee',   desc: 'You know each employee\'s contribution % and/or earnings per task' },
                  { key: 'earnings_only', label: 'Earnings only',           desc: 'You only know the ₹ amount each employee earned — no score %' },
                  { key: 'param_detail',  label: 'Parameter detail',        desc: 'You have exact values per parameter (Design score, revision counts, etc.)' },
                ] as { key: ContribSubMode; label: string; desc: string }[]).map(({ key, label, desc }) => (
                  <label key={key} className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${contribSubMode === key ? 'border-violet-500/60 bg-violet-500/10' : 'border-border hover:border-violet-500/30'}`}>
                    <input type="radio" name="contribSubMode" value={key} checked={contribSubMode === key}
                      onChange={() => setContribSubMode(key)} className="mt-0.5 accent-violet-500" />
                    <div>
                      <p className="text-xs font-semibold">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>
                  </label>
                ))}

                {/* Dynamic template download for this sub-mode */}
                <button
                  onClick={() => {
                    let header = '', example = ''
                    if (contribSubMode === 'earnings_only') {
                      header = 'id,task_id,task_title,task_date,employee_cqid,earnings_inr'
                      example = ['"","","Social Media Pack Jun","2026-05-01","CQ001","3000"', '"","","Social Media Pack Jun","2026-05-01","CQ002","2000"'].join('\n')
                    } else if (contribSubMode === 'score_pct') {
                      header = 'id,task_id,task_title,task_date,employee_cqid,score_percentage,earnings_inr'
                      example = ['"","","Social Media Pack Jun","2026-05-01","CQ001","60","3000"', '"","","Social Media Pack Jun","2026-05-01","CQ002","40","2000"'].join('\n')
                    } else {
                      const paramZeros = parameters.map(() => '0').join(',')
                      header = `id,task_id,task_title,task_date,employee_cqid,${parameters.map(p => p.name).join(',')}`
                      example = `"","","Social Media Pack Jun","2026-05-01","CQ001",${paramZeros}\n"","","Social Media Pack Jun","2026-05-01","CQ002",${paramZeros}`
                    }
                    const blob = new Blob([header + '\n' + example], { type: 'text/csv;charset=utf-8;' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `contributions_${contribSubMode}_template.csv`
                    a.click()
                    URL.revokeObjectURL(a.href)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-300 text-xs font-medium hover:bg-violet-600/30 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                  Download {contribSubMode === 'earnings_only' ? 'Earnings-Only' : contribSubMode === 'score_pct' ? 'Score %' : 'Parameter Detail'} Template
                </button>

                {contribSubMode === 'param_detail' && (
                  <div className="text-[11px] text-muted-foreground bg-background/40 rounded-lg p-2 space-y-0.5">
                    <p className="font-semibold text-foreground/70">Parameters in template ({parameters.length}):</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {groups.map(g => (
                        <span key={g.id} className="text-[10px]">
                          <span className="text-violet-400 font-semibold">{g.name}:</span>{' '}
                          {parameters.filter(p => p.group_id === g.id).map(p => p.name).join(', ')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(contribSubMode === 'score_pct' || contribSubMode === 'earnings_only') && (
                  <p className="text-[11px] text-blue-400">💡 <strong>task_id</strong> column: paste the Supabase task ID directly to skip title+date matching. Leave blank to match by title+date.</p>
                )}
              </div>
            )}

            {renderReference()}
          </div>
        </div>
      )}

      {/* ── PREVIEW ─────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'preview' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold">{rows.length} rows parsed</span>
            <span className="text-[12px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-semibold">{okCount} ready</span>
            {warnCount > 0 && <span className="text-[12px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-semibold">{warnCount} warnings</span>}
            {errorCount > 0 && <span className="text-[12px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">{errorCount} errors (skipped)</span>}
            <div className="flex-1"/>
            <button onClick={reset} className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground">
              ← Re-upload
            </button>
            <button
              onClick={runImport}
              disabled={importing || okCount + warnCount === 0}
              className="text-sm px-4 py-2 rounded-lg bg-violet-600 text-white font-semibold hover:bg-violet-500 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Importing…' : `Import ${okCount + warnCount} row${okCount + warnCount !== 1 ? 's' : ''}`}
            </button>
          </div>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">{renderPreviewTable()}</div>
          </div>
        </div>
      )}

      {/* ── DONE ────────────────────────────────────────────────────────────── */}
      {pageTab === 'import' && step === 'done' && result && (
        <div className="bg-card border border-border rounded-xl p-8 text-center space-y-4 max-w-lg mx-auto">
          <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center text-2xl ${result.inserted > 0 ? 'bg-green-500/15' : 'bg-red-500/15'}`}>
            {result.inserted > 0 ? '✅' : '❌'}
          </div>
          <div>
            <p className="text-xl font-bold">{result.inserted} {MODES.find(m => m.key === mode)?.label} {operation === 'update' ? 'updated' : operation === 'delete' ? 'deleted' : 'imported'}</p>
            {result.skipped > 0 && <p className="text-sm text-yellow-400">{result.skipped} rows skipped</p>}
          </div>
          {result.errors.length > 0 && (
            <div className="text-left bg-red-500/10 border border-red-500/30 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-red-400">Errors:</p>
              {result.errors.map((e, i) => <p key={i} className="text-xs text-red-300">{e}</p>)}
            </div>
          )}
          <div className="flex gap-3 justify-center">
            <button onClick={reset} className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-500 transition-colors">
              Import More
            </button>
            <button onClick={() => { reset(); setMode(mode) }} className="px-4 py-2 rounded-lg border border-border text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">
              New Type
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
