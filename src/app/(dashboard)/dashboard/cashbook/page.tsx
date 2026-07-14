import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripCashbookList } from '@/lib/permissions/strip'
import CashBookClient from './cashbook-client'

export const dynamic = 'force-dynamic'

// Shared join fragments used by both the full and legacy (pre-tags-migration) selects.
const CORE_JOINS = `
  category:cashbook_categories(id, name, type),
  bank_account:bank_accounts(id, name),
  allocations:cashbook_invoice_allocations(
    id,
    invoice_id,
    allocated_amount,
    deleted_at,
    invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, total_amount_inr, exchange_rate, currency, client:clients(id, name))
  ),
  direct_invoice:invoices!invoice_id(
    invoice_number, status, due_date, total_amount, paid_amount, total_amount_inr, exchange_rate, currency, client:clients(id, name)
  ),
  payroll_allocations:cashbook_payroll_allocations(
    id,
    payroll_id,
    allocated_amount,
    deleted_at,
    payroll:payroll(employee_id, net_salary, status, employee:employees(cqid, name))
  ),
  expense_billings:invoice_expense_items(
    id,
    invoice_id,
    invoice:invoices(invoice_number, status)
  )
`.trim()

// Tags + employee cost splits (migration 20260714160000). Kept as a separate
// fragment so a pre-migration DB can retry without it instead of erroring the
// entire entries query — Supabase fails a select outright if any embedded
// relation in it doesn't exist.
const TAGS_AND_SPLITS_JOINS = `
  tags:cashbook_entry_tags(tag:cashbook_tags(id, name)),
  employee_splits:cashbook_entry_employee_splits(id, employee_id, amount, amount_inr, employee:employees(id, name, cqid))
`.trim()

// Both branches are cast to `string` for `.select()` — Supabase's literal-string
// type inference otherwise tries (and fails) to unify two structurally
// different embedded-relation shapes across the retry.
const FULL_ENTRIES_SELECT: string = `*, ${CORE_JOINS}, ${TAGS_AND_SPLITS_JOINS}`
const CORE_ENTRIES_SELECT: string = `*, ${CORE_JOINS}`

async function fetchCashbookEntries(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<{ data: any[] | null; error: { message: string } | null }> {
  let { data, error } = await supabase
    .from('cashbook_entries')
    .select(FULL_ENTRIES_SELECT)
    .is('deleted_at', null)
    .order('entry_date', { ascending: false })
    .limit(5000)

  if (error && /cashbook_entry_tags|cashbook_tags|cashbook_entry_employee_splits|schema cache/i.test(error.message || '')) {
    // Tags/splits migration not applied yet — degrade to the core select.
    ;({ data, error } = await supabase
      .from('cashbook_entries')
      .select(CORE_ENTRIES_SELECT)
      .is('deleted_at', null)
      .order('entry_date', { ascending: false })
      .limit(5000))
  }
  return { data: data as any[] | null, error }
}

export default async function CashBookPage() {
  // Route is permission-gated by middleware (`cashbook.view`). Per-field ₹
  // visibility is gated below by the `cashbook.view_amounts` perm — users
  // without it can still browse entries, categories, dates, descriptions
  // but the amount column is stripped server-side.
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const supabase = createAdminClient()

  const [entriesRes, categoriesRes, bankAccountsRes, exchangeRatesRes, dueInvoicesRes, employeesRes, clientsRes, creditsRes, pendingPayrollsRes, companySettingsRes, tagsRes] = await Promise.all([
    fetchCashbookEntries(supabase),
    supabase.from('cashbook_categories').select('*').order('type').order('name'),
    supabase.from('bank_accounts').select('id, name, type, is_active, is_default').order('name'),
    supabase.from('exchange_rates').select('*'),
    supabase
      .from('invoices')
      .select('id, invoice_number, status, issue_date, due_date, total_amount, paid_amount, total_amount_inr, paid_amount_inr, exchange_rate, currency, client_id, client:clients(id, name, code), payments(id)')
      .in('status', ['draft', 'reviewed', 'sent', 'partial', 'overdue'])
      .order('due_date', { ascending: true }),
    supabase.from('employees').select('id, cqid, name, role').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    supabase.from('credit_ledger').select('*, employee:employees(cqid)').eq('credit_type', 'given').order('credit_date', { ascending: false }),
    // Pending payslips power the salary-expense picker in the entry form.
    // Filtered to status='pending' so paid payslips don't pollute the list,
    // sorted newest-first (year desc, month desc) so the auto-default lands
    // on the most recent unpaid month for the selected employee.
    supabase
      .from('payroll')
      .select('id, employee_id, month, year, payslip_number, net_salary, status, employee:employees(cqid, name)')
      .eq('status', 'pending')
      .order('year', { ascending: false })
      .order('month', { ascending: false }),
    // Pull the small set of company branding keys we need on receipts so the
    // workspace's own logo/name/phone replaces the hardcoded Cirqle defaults.
    // Same pattern as invoices/page.tsx — key/value rows materialised into a
    // flat lookup in the client.
    supabase
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url', 'logo_url_dark', 'company_name', 'company_phone', 'company_website']),
    // All known tags, for the TagPicker's autocomplete. Best-effort: `.data`
    // is null (not thrown) if the tags migration (20260714160000) isn't
    // applied yet — the `|| []` below covers it.
    supabase.from('cashbook_tags').select('id, name').order('name'),
  ])

  // Materialise the key/value pairs into a flat object. Empty strings collapse
  // to undefined so the receipt renderer can use `??` for clean fallbacks.
  const companySettings = (companySettingsRes.data || []).reduce<Record<string, string>>((acc, r: any) => {
    const v = (r.value || '').toString().trim()
    if (v) acc[r.key] = v
    return acc
  }, {})

  // Strip amount + amount_inr from cashbook entries (plus nested allocation
  // totals + invoice/payroll totals on the join) when the viewer lacks
  // `cashbook.view_amounts`. The data never reaches the client's JS state.
  const initialEntries = stripCashbookList((entriesRes.data || []) as any[], vis.cashbookAmounts)

  return (
    <CashBookClient
      initialEntries={initialEntries}
      categories={categoriesRes.data || []}
      bankAccounts={bankAccountsRes.data || []}
      exchangeRates={exchangeRatesRes.data || []}
      dueInvoices={(dueInvoicesRes.data || []) as any[]}
      employees={(employeesRes.data || []) as any[]}
      clients={(clientsRes.data || []) as any[]}
      outstandingCredits={(creditsRes.data || []) as any[]}
      pendingPayrolls={(pendingPayrollsRes.data || []) as any[]}
      companySettings={companySettings}
      showAmounts={vis.cashbookAmounts}
      allTags={((tagsRes as any)?.data || []).map((t: any) => t.name as string)}
    />
  )
}
