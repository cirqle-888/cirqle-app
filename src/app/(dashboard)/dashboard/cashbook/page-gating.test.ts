import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * The Cash Book page loads three lists purely to populate the entry form's
 * allocation pickers — open invoices, employee credits, pending payslips — and
 * each carries money this page's own permission (`cashbook.view`) does not
 * cover. They were fetched unconditionally, so a data-entry user explicitly
 * denied billing and payroll visibility still received every open invoice
 * total and every pending net salary in the page payload.
 *
 * Guarded at the QUERY, not in the UI: hiding a field still ships it. This test
 * pins that, because the failure is invisible on screen — the leak lives in the
 * RSC payload, not in anything rendered.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/app/(dashboard)/dashboard/cashbook/page.tsx'),
  'utf8',
)

describe('cashbook page — money the page permission does not cover is gated at the query', () => {
  it('only fetches open invoices when the viewer can see billing amounts', () => {
    expect(SRC).toMatch(/vis\.billingAmounts\s*\n?\s*\?\s*supabase[\s\S]{0,120}from\('invoices'\)/)
  })

  it('only fetches pending payslips when the viewer can see payroll amounts', () => {
    expect(SRC).toMatch(/vis\.payrollAmounts\s*\n?\s*\?\s*supabase[\s\S]{0,160}from\('payroll'\)/)
  })

  it('only fetches the employee credit ledger when the viewer can see payroll amounts', () => {
    expect(SRC).toMatch(/vis\.payrollAmounts\s*\n?\s*\?\s*supabase\.from\('credit_ledger'\)/)
  })

  it('still strips amounts off the entries themselves', () => {
    expect(SRC).toContain('stripCashbookList')
    expect(SRC).toContain('vis.cashbookAmounts')
  })

  it('passes the payroll axis to the entry strip', () => {
    // The ENTRIES join also carries net_salary (via payroll_allocations), and
    // that one is not gated by the query — it is stripped. It must be stripped
    // on payroll visibility, not on cashbook visibility.
    expect(SRC).toContain('stripCashbookList((entriesRes.data || []) as any[], vis.cashbookAmounts, vis.payrollAmounts)')
  })
})
