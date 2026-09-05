import { createAdminClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import {
  financialVisibility,
  stripPayrollListAmounts,
  stripAmountList,
  stripScoreListEarnings,
} from '@/lib/permissions/strip'
import PayrollClient from './payroll-client'

export const dynamic = 'force-dynamic'

export default async function PayrollPage() {
  // Route is permission-gated by middleware (`payroll.view`); only authorized
  // users reach this code path. Per-field ₹ visibility is governed by the
  // `payroll.view_amounts` perm — viewers without it can still see the
  // payroll status flow (Draft / Reviewed / Paid) and approve transitions,
  // but salary/commission/advance/deduction amounts are stripped server-side.
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const supabase = createAdminClient()
  const now = new Date()
  const currentYear = now.getFullYear()

  // 24-month window for scores history. Payroll's 6-month employee chart only
  // ever looks at viewMonth ± 5 months, so anything beyond 24 is dead weight.
  const scoresWindowFrom = new Date()
  scoresWindowFrom.setMonth(scoresWindowFrom.getMonth() - 24)
  const scoresWindowFromStr = scoresWindowFrom.toISOString()

  const [employeesRes, payrollRes, advancesRes, creditRes, deductionsRes, scoresRes, tasksRes] = await Promise.all([
    fetchAll(stablePaginationQuery(
      supabase.from('employees').select('*').order('cqid')
    )),
    // Payroll: cap at 60 months (5 years) — older months can't be navigated to
    // via the UI's prev/next chevrons within a reasonable session.
    fetchAll(stablePaginationQuery(
      supabase
        .from('payroll')
        .select('*, employee:employees(id, cqid, name)')
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(60 * 30) // worst-case 30 employees × 60 months
    )),
    fetchAll(stablePaginationQuery(
      supabase
        .from('salary_advances')
        .select('*, employee:employees(id, cqid)')
        .order('advance_date', { ascending: false })
    )),
    fetchAll(stablePaginationQuery(
      supabase
        .from('credit_ledger')
        .select('*, employee:employees(id, cqid)')
        .order('credit_date', { ascending: false })
    )),
    fetchAll(stablePaginationQuery(
      supabase
        .from('deductions')
        .select('*, employee:employees(id, cqid)')
        .order('created_at', { ascending: false })
    )),
    // Scores within the analytics window (24 months). Older scores can never
    // surface in the UI which only navigates ±5 months from current.
    fetchAll(stablePaginationQuery(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, earnings_inr, score_percentage, is_manual_override, earning_source, calculated_at, task:tasks(id, task_date, title, status)')
        .gte('calculated_at', scoresWindowFromStr)
        .order('calculated_at', { ascending: false })
    )),
    // Completed tasks for missing-contributions detection — already bounded.
    // 'delivered' is excluded: contribution scoring is prompted only once a task
    // is Completed (done), keeping commission tied to the billable state.
    fetchAll(stablePaginationQuery(
      supabase
        .from('tasks')
        .select('id, title, task_date, status, billing_amount_inr, client:clients(name), service:services!service_id(name)')
        .in('status', ['done', 'invoiced', 'paid'])
        // Trashed tasks are not work anybody still owes a score for. Without
        // this the Overview warned "7 completed tasks missing contribution
        // scores in Aug" and listed seven DELETED variants — two of them the
        // same title twice — sending someone to score rows that no longer
        // exist. Every sibling page (clients, ranking, recurring) already
        // filters this; payroll was the one that did not.
        .is('deleted_at', null)
        .gte('task_date', `${currentYear - 1}-01-01`)
        .order('task_date', { ascending: false })
    )),
  ])


  // Server-side strip when the viewer lacks `payroll.view_amounts`. Money
  // fields (base_salary, commission_earned, net_salary, advance amounts,
  // credit amounts, deduction amounts, contribution earnings_inr) are
  // removed from the payload before it ever reaches the client. The viewer
  // still sees employee + status data so they can manage workflow.
  const payrollRecords = stripPayrollListAmounts(payrollRes.data || [], vis.payrollAmounts)
  const advances       = stripAmountList(advancesRes.data || [], vis.payrollAmounts)
  const credits        = stripAmountList(creditRes.data || [], vis.payrollAmounts)
  const deductions     = stripAmountList(deductionsRes.data || [], vis.payrollAmounts)
  // Scores' earnings_inr is gated by contributions.view_earnings (orthogonal
  // perm — a payroll-amount viewer might or might not also see contribution
  // earnings, depending on designation).
  const contributionScores = stripScoreListEarnings(
    (scoresRes.data || []) as any[],
    vis.contributionEarnings,
  )

  // Task billing value is pricing data, not payroll data — gate it on the same
  // permission the Tasks page uses rather than letting it ride in on
  // payroll.view_amounts. Without it the modal simply omits the derivation row.
  const allTasks = (tasksRes.data || []).map((t: Record<string, unknown>) =>
    vis.tasksPricing ? t : { ...t, billing_amount_inr: undefined })

  return (
    <PayrollClient
      employees={employeesRes.data || []}
      payrollRecords={payrollRecords}
      advances={advances}
      credits={credits}
      deductions={deductions}
      contributionScores={contributionScores}
      allTasks={allTasks as any[]}
      showAmounts={vis.payrollAmounts}
    />
  )
}
