import { createClient } from '@/lib/supabase/server'
import CashBookClient from './cashbook-client'

export default async function CashBookPage() {
  const supabase = await createClient()

  const [entriesRes, categoriesRes, bankAccountsRes, exchangeRatesRes, dueInvoicesRes, employeesRes, clientsRes, creditsRes] = await Promise.all([
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
          invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, client:clients(name))
        ),
        payroll_allocations:cashbook_payroll_allocations(
          id,
          payroll_id,
          allocated_amount,
          payroll:payroll(employee_id, net_salary, status, employee:employees(cqid, name))
        )
      `)
      .is('deleted_at', null)
      .order('entry_date', { ascending: false })
      .limit(5000),
    supabase.from('cashbook_categories').select('*').order('type').order('name'),
    supabase.from('bank_accounts').select('id, name, type, is_active').order('name'),
    supabase.from('exchange_rates').select('*'),
    supabase
      .from('invoices')
      .select('id, invoice_number, status, due_date, total_amount, paid_amount, currency, client:clients(name, code)')
      .in('status', ['draft', 'reviewed', 'sent', 'partial'])
      .order('due_date', { ascending: true }),
    supabase.from('employees').select('id, cqid, role').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    supabase.from('credit_ledger').select('*, employee:employees(cqid)').eq('credit_type', 'given').order('credit_date', { ascending: false }),
  ])

  return (
    <CashBookClient
      initialEntries={entriesRes.data || []}
      categories={categoriesRes.data || []}
      bankAccounts={bankAccountsRes.data || []}
      exchangeRates={exchangeRatesRes.data || []}
      dueInvoices={(dueInvoicesRes.data || []) as any[]}
      employees={(employeesRes.data || []) as any[]}
      clients={(clientsRes.data || []) as any[]}
      outstandingCredits={(creditsRes.data || []) as any[]}
    />
  )
}
