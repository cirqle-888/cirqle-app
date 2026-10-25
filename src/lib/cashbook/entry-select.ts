/**
 * The full cash-book entry select used when an action returns rows for the
 * Cash Book to put straight into its list. Shared by every cash-book action
 * module (a 'use server' file may only export async functions, so it cannot
 * live in one of them).
 *
 * The allocation embeds NAME their relationship (`!cashbook_entry_id`). Each
 * allocation table also has `released_by_entry_id`, and should a foreign key
 * ever exist on it, an unhinted embed is ambiguous to PostgREST (PGRST201)
 * and the whole query fails — which took the Cash Book down on 2026-10-16.
 * Every embed between cashbook_entries and an allocation table carries the
 * same hint, in both directions.
 */
export const ENTRY_SELECT = `
  *,
  category:cashbook_categories(id, name, type, account_code),
  bank_account:bank_accounts(id, name),
  allocations:cashbook_invoice_allocations!cashbook_entry_id(
    id, invoice_id, allocated_amount, deleted_at,
    invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, client:clients(name))
  ),
  payroll_allocations:cashbook_payroll_allocations!cashbook_entry_id(
    id, payroll_id, allocated_amount, deleted_at,
    payroll:payroll(net_salary, status, employee:employees(name, cqid))
  )
`.trim()
