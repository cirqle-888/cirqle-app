/**
 * Centralized field-stripping helpers for financial visibility.
 *
 * RULE OF THUMB
 * --------------
 * If a designation lacks the matching `*.view_amounts` / `view_earnings` /
 * `view_pricing` permission, the corresponding ₹ field MUST be removed from
 * the payload BEFORE it leaves the server. UI-only hiding is not sufficient:
 * the field would still appear in the RSC stream, network responses, and
 * React DevTools state.
 *
 * Every server page that loads financial data should funnel its raw query
 * results through the appropriate strip* helper here, parameterised by a
 * boolean `canView`. This keeps the truth in one file and makes audits cheap.
 */

import { PERMS } from './keys'
import type { CurrentUser } from './check'

// ─────────────────────────────────────────────────────────────────────────────
// Permission check entrypoints
// ─────────────────────────────────────────────────────────────────────────────

/** True if the user is an admin or holds the named permission. */
export function userCanSee(user: CurrentUser | null, perm: string): boolean {
  if (!user) return true   // pre-migration / no auth context: fail-open (server still gates)
  if (user.isArchived) return false
  if (user.isAdmin) return true
  return user.permissions.has(perm)
}

/** Bundle of all financial-visibility flags computed once per request. */
export interface FinancialVisibility {
  tasksPricing:         boolean
  contributionEarnings: boolean
  payrollAmounts:       boolean
  billingAmounts:       boolean
  billingLinePricing:   boolean
  cashbookAmounts:      boolean
}

export function financialVisibility(user: CurrentUser | null): FinancialVisibility {
  return {
    tasksPricing:         userCanSee(user, PERMS.TASKS_VIEW_PRICING),
    contributionEarnings: userCanSee(user, PERMS.CONTRIBUTIONS_VIEW_EARNINGS),
    payrollAmounts:       userCanSee(user, PERMS.PAYROLL_VIEW_AMOUNTS),
    billingAmounts:       userCanSee(user, PERMS.BILLING_VIEW_AMOUNTS),
    billingLinePricing:   userCanSee(user, PERMS.BILLING_VIEW_LINE_PRICING),
    cashbookAmounts:      userCanSee(user, PERMS.CASHBOOK_VIEW_AMOUNTS),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-specific strippers
//
// Each takes a row (or array of rows) plus the visibility flag and returns a
// shape with the ₹ fields removed when the flag is false. The original input
// is never mutated; callers can safely pass server query results directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Tasks: billing_amount / billing_amount_inr / currency / loss_amount / billing_* */
export function stripTaskPricing<T extends Record<string, any>>(task: T, canView: boolean): T {
  if (canView || task == null) return task
  const {
    billing_amount, billing_amount_inr, currency, loss_amount,
    billing_mode, billing_percent, billing_override, is_billable, honor_contributions,
    ...rest
  } = task
  // Silence unused-binding linter warnings (these names exist only to destructure-out).
  void billing_amount; void billing_amount_inr; void currency; void loss_amount
  void billing_mode; void billing_percent; void billing_override; void is_billable; void honor_contributions
  return rest as T
}
export function stripTaskListPricing<T extends Record<string, any>>(tasks: T[], canView: boolean): T[] {
  if (canView) return tasks
  return tasks.map(t => stripTaskPricing(t, false))
}

/**
 * Client agreements: unit_price / extra_unit_price / currency.
 * Committed quantities and progress stay visible — they are deliberately
 * non-financial (same call the app already makes for tasks.quantity).
 */
export function stripAgreementItemPricing<T extends Record<string, any>>(item: T, canView: boolean): T {
  if (canView || item == null) return item
  // Strip client-facing pricing AND internal allocation money (operational, but
  // still financial — must not leak to viewers without agreements.view_pricing).
  const {
    unit_price, extra_unit_price, currency,
    creative_allocation_amount, management_allocation_amount, allocated_unit_value,
    ...rest
  } = item
  void unit_price; void extra_unit_price; void currency
  void creative_allocation_amount; void management_allocation_amount; void allocated_unit_value
  return rest as T
}
export function stripAgreementItemListPricing<T extends Record<string, any>>(items: T[], canView: boolean): T[] {
  if (canView) return items
  return items.map(i => stripAgreementItemPricing(i, false))
}

/** Contribution scores: earnings_inr */
export function stripScoreEarnings<T extends Record<string, any>>(score: T, canView: boolean): T {
  if (canView || score == null) return score
  const { earnings_inr, ...rest } = score
  void earnings_inr
  return rest as T
}
export function stripScoreListEarnings<T extends Record<string, any>>(scores: T[], canView: boolean): T[] {
  if (canView) return scores
  return scores.map(s => stripScoreEarnings(s, false))
}

/**
 * Payroll rows: base_salary / commission_earned / net_salary plus typical
 * companion fields used by the payroll page (gross, deductions_total, etc.
 * if present).
 */
export function stripPayrollAmounts<T extends Record<string, any>>(row: T, canView: boolean): T {
  if (canView || row == null) return row
  const {
    base_salary, commission_earned, net_salary, gross_salary,
    deductions_total, advances_total, credits_total, paid_amount,
    ...rest
  } = row
  void base_salary; void commission_earned; void net_salary; void gross_salary
  void deductions_total; void advances_total; void credits_total; void paid_amount
  return rest as T
}
export function stripPayrollListAmounts<T extends Record<string, any>>(rows: T[], canView: boolean): T[] {
  if (canView) return rows
  return rows.map(r => stripPayrollAmounts(r, false))
}

/** Generic single-amount row: salary_advances, credit_ledger, deductions. */
export function stripAmountRow<T extends Record<string, any>>(row: T, canView: boolean): T {
  if (canView || row == null) return row
  const { amount, ...rest } = row
  void amount
  return rest as T
}
export function stripAmountList<T extends Record<string, any>>(rows: T[], canView: boolean): T[] {
  if (canView) return rows
  return rows.map(r => stripAmountRow(r, false))
}

/** Invoices: total_amount / paid_amount + nested items + payments + tasks billing fields. */
export function stripInvoiceAmounts<T extends Record<string, any>>(
  invoice: T,
  flags: { amounts: boolean; linePricing: boolean },
): T {
  if (invoice == null) return invoice
  if (flags.amounts && flags.linePricing) return invoice
  const out: any = { ...invoice }
  if (!flags.amounts) {
    delete out.total_amount
    delete out.paid_amount
    delete out.total_amount_inr
    delete out.paid_amount_inr
    delete out.subtotal
    delete out.tax_amount
    delete out.discount_amount
    if (Array.isArray(out.payments)) {
      out.payments = out.payments.map((p: any) => {
        const { amount, amount_inr, ...rest } = p
        void amount; void amount_inr
        return rest
      })
    }
  }
  if (!flags.linePricing) {
    if (Array.isArray(out.items)) {
      out.items = out.items.map((it: any) => {
        const { amount, unit_price, line_total, ...rest } = it
        void amount; void unit_price; void line_total
        // task nested join may carry billing_amount_inr — strip that too
        if (rest.task) rest.task = stripTaskPricing(rest.task, false)
        return rest
      })
    }
  }
  return out as T
}
export function stripInvoiceList<T extends Record<string, any>>(
  invoices: T[],
  flags: { amounts: boolean; linePricing: boolean },
): T[] {
  if (flags.amounts && flags.linePricing) return invoices
  return invoices.map(i => stripInvoiceAmounts(i, flags))
}

/**
 * Cashbook entries: amount + amount_inr + nested invoice/payroll allocation
 * totals.
 */
export function stripCashbookAmounts<T extends Record<string, any>>(entry: T, canView: boolean): T {
  if (canView || entry == null) return entry
  const out: any = { ...entry }
  delete out.amount
  delete out.amount_inr
  if (Array.isArray(out.allocations)) {
    out.allocations = out.allocations.map((a: any) => {
      const { allocated_amount, ...rest } = a
      void allocated_amount
      if (rest.invoice) {
        const { total_amount, paid_amount, ...irest } = rest.invoice
        void total_amount; void paid_amount
        rest.invoice = irest
      }
      return rest
    })
  }
  if (Array.isArray(out.payroll_allocations)) {
    out.payroll_allocations = out.payroll_allocations.map((a: any) => {
      const { allocated_amount, ...rest } = a
      void allocated_amount
      if (rest.payroll) {
        const { net_salary, ...prest } = rest.payroll
        void net_salary
        rest.payroll = prest
      }
      return rest
    })
  }
  if (Array.isArray(out.employee_splits)) {
    out.employee_splits = out.employee_splits.map((s: any) => {
      const { amount, amount_inr, ...rest } = s
      void amount; void amount_inr
      return rest
    })
  }
  return out as T
}
export function stripCashbookList<T extends Record<string, any>>(entries: T[], canView: boolean): T[] {
  if (canView) return entries
  return entries.map(e => stripCashbookAmounts(e, false))
}

/** Client-service pricing rows. Always admin-or-permitted to see. */
export function stripPricingMatrix<T extends Record<string, any>>(rows: T[], canView: boolean): T[] {
  if (canView) return rows
  return [] // pricing matrix is meaningless without amounts; suppress entirely
}
