import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripCashbookList } from '@/lib/permissions/strip'
import CashBookClient from './cashbook-client'

export const dynamic = 'force-dynamic'

export default async function CashBookPage() {
  // Route is permission-gated by middleware (`cashbook.view`). Per-field ₹
  // visibility is gated below by the `cashbook.view_amounts` perm — users
  // without it can still browse entries, categories, dates, descriptions
  // but the amount column is stripped server-side.
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const supabase = createAdminClient()

  const [entriesRes, categoriesRes, bankAccountsRes, exchangeRatesRes, dueInvoicesRes, employeesRes, clientsRes, creditsRes, pendingPayrollsRes, companySettingsRes] = await Promise.all([
    supabase
      .from('cashbook_entries')
      .select(`
        *, 
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
      `)
      .is('deleted_at', null)
      .order('entry_date', { ascending: false })
      .limit(5000),
    supabase.from('cashbook_categories').select('*').order('type').order('name'),
    supabase.from('bank_accounts').select('id, name, type, is_active, is_default').order('name'),
    supabase.from('exchange_rates').select('*'),
    supabase
      .from('invoices')
      .select('id, invoice_number, status, issue_date, due_date, total_amount, paid_amount, total_amount_inr, paid_amount_inr, exchange_rate, currency, client_id, client:clients(id, name, code), payments(id)')
      .in('status', ['draft', 'reviewed', 'sent', 'partial', 'overdue'])
      .order('due_date', { ascending: true }),
    supabase.from('employees').select('id, cqid, role').eq('is_active', true).order('cqid'),
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
    />
  )
}
