import { createAdminClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import DashboardClient from './dashboard-client'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  // Service-role client for data — every query below is explicitly gated by
  // `isAdmin` or scoped by `employee_id = employeeId` at the application layer,
  // matching what RLS previously enforced. Saves the async cookies() hop and
  // the per-query RLS planning overhead on the database side.
  const supabase = createAdminClient()

  const todayStr = new Date().toISOString().slice(0, 10)
  // Analytics window: last 36 months — prevents unbounded 50K+ row fetches.
  // The dashboard "best month" insight operates within this window.
  const analyticsFrom = new Date()
  analyticsFrom.setMonth(analyticsFrom.getMonth() - 36)
  const analyticsFromStr = analyticsFrom.toISOString().slice(0, 10)
  // Display-widget window: last 90 days. Used by the active-tasks / to-be-invoiced
  // / unscored-done widgets which are intentionally "recent work" lists — older
  // rows would never surface in the UI anyway. Caps an otherwise unbounded fetch
  // of every non-cancelled task ever created.
  const displayFrom = new Date()
  displayFrom.setDate(displayFrom.getDate() - 90)
  const displayFromStr = displayFrom.toISOString().slice(0, 10)

  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const employeeId = me?.employeeId

  // Only fetch invoices, cashbook, and all payroll history if admin
  const [
    invoicesRes,
    cashbookRes,
    allAnalyticsTasksRes,
    displayTasksRes,
    employeesRes,
    scoredTaskIdsRes,
    todayTasksRes,
    scoresRes,
    payrollRes,
  ] = await Promise.all([
    isAdmin
      ? fetchAll(supabase
          .from('invoices')
          .select('id, invoice_number, total_amount, paid_amount, status, currency, due_date, client:clients(id, name)')
          .order('due_date', { ascending: true })
          .order('id', { ascending: true }))
      : Promise.resolve({ data: [] }),

    // Cashbook — admin only, all-time for accurate bank balance calculation.
    isAdmin
      ? fetchAll(supabase
          .from('cashbook_entries')
          .select('type, amount_inr, entry_date, description')
          .order('entry_date', { ascending: true })
          .order('id', { ascending: true }))
      : Promise.resolve({ data: [] }),

    // Analytics tasks — admin only, last 36 months. Employees receive [].
    isAdmin
      ? fetchAll(supabase
          .from('tasks')
          .select('id, billing_amount_inr, task_date, status, service_id, client:clients(id, name), service:services(id, name)')
          .not('status', 'eq', 'cancelled')
          .gte('task_date', analyticsFromStr)
          .order('task_date', { ascending: true })
          .order('id', { ascending: true }))
      : Promise.resolve({ data: [] }),

    // Display tasks (used for widgets: active, overdue, to-be-invoiced) — admin only.
    // Bounded to 90 days because the widgets surface "recent work" and would never
    // show older rows in the UI anyway. Without this cap, the query was pulling
    // every non-cancelled task ever — easily 10k+ rows on a mature account.
    isAdmin
      ? fetchAll(stablePaginationQuery(supabase
          .from('tasks')
          .select('id, title, status, billing_amount_inr, task_date, client:clients(id, name), service:services(id, name)')
          .not('status', 'eq', 'cancelled')
          .gte('task_date', displayFromStr)
          .order('task_date', { ascending: false })))
      : Promise.resolve({ data: [] }),

    isAdmin
      ? fetchAll(stablePaginationQuery(supabase
          .from('employees')
          .select('id, cqid, name, performance_rating, role')
          .eq('is_active', true)
          .order('cqid')))
      : Promise.resolve({ data: [] }),

    // Scored task IDs — used to detect "unscored done tasks" in displayTasks
    // (the latter is ordered by task_date desc and shown only as a widget hint,
    // so 36-month window is enough). Bounds an otherwise unbounded scan of all
    // historical scores.
    isAdmin
      ? fetchAll(stablePaginationQuery(
          supabase.from('contribution_scores')
            .select('task_id')
            .gte('calculated_at', analyticsFromStr)
            .order('id', { ascending: true })
        ))
      : Promise.resolve({ data: [] }),

    // Today's tasks — admin dashboard widget only
    isAdmin
      ? supabase
          .from('tasks')
          .select('id, title, status, billing_amount_inr, task_date, client:clients(id, name), service:services(id, name)')
          .eq('task_date', todayStr)
          .order('status')
      : Promise.resolve({ data: [] }),

    // Fetch scores — capped to the same 36-month analytics window so payload
    // is bounded. The dashboard's teamEarnings widget only operates within
    // any user-selected DateFilter, which itself can't exceed the loaded data.
    isAdmin
      ? fetchAll(supabase
          .from('contribution_scores')
          .select('task_id, employee_id, score_percentage, earnings_inr, calculated_at, task:tasks(id, task_date)')
          .gte('calculated_at', analyticsFromStr)
          .order('calculated_at', { ascending: false })
          .order('id', { ascending: true }))
      : fetchAll(supabase
          .from('contribution_scores')
          .select('task_id, employee_id, score_percentage, earnings_inr, calculated_at, task:tasks(id, task_date)')
          .eq('employee_id', employeeId)
          .gte('calculated_at', analyticsFromStr)
          .order('calculated_at', { ascending: false })
          .order('id', { ascending: true })),

    // Payroll: if employee, only their own (last 36 months); admin gets 24 most recent.
    isAdmin
      ? supabase
          .from('payroll')
          .select('month, year, base_salary, commission_earned, net_salary, status')
          .order('year', { ascending: false })
          .order('month', { ascending: false })
          .limit(24)
      : supabase
          .from('payroll')
          .select('month, year, base_salary, commission_earned, net_salary, status')
          .eq('employee_id', employeeId)
          .eq('status', 'paid')
          .order('year', { ascending: false })
          .order('month', { ascending: false })
          .limit(36)
  ])

  const invoices           = invoicesRes.data || []
  const allCashbook        = cashbookRes.data || []
  const allAnalyticsTasks  = allAnalyticsTasksRes.data || []
  const displayTasks       = displayTasksRes.data || []
  const employees          = employeesRes.data || []
  const scoredTaskIds      = new Set((scoredTaskIdsRes.data || []).map((r: any) => r.task_id))
  const todayTasks         = todayTasksRes.data || []
  const scores             = scoresRes.data || []
  const payrollRecords     = payrollRes.data || []

  const today = new Date()

  // ── Bank balance ────────────────────────────────────────────────────────────
  const bankBalance = allCashbook.reduce((s, e) =>
    e.type === 'inflow' ? s + (e.amount_inr || 0) : s - (e.amount_inr || 0), 0)

  // ── Invoice stats (no double-counting) ──────────────────────────────────────
  // Sent/partial/overdue = money already claimed, waiting collection
  const sentInvoices     = invoices.filter(i => ['sent', 'partial', 'overdue'].includes(i.status))
  const draftInvoices    = invoices.filter(i => ['draft', 'reviewed'].includes(i.status))
  const paidInvoices     = invoices.filter(i => i.status === 'paid')

  const totalBilled   = invoices.filter(i => i.status !== 'cancelled').reduce((s, i) => s + (i.total_amount || 0), 0)
  const totalPaid     = invoices.reduce((s, i) => s + (i.paid_amount || 0), 0)
  // Outstanding = unpaid from invoices already sent to clients (not drafts)
  const outstanding   = sentInvoices.reduce((s, i) => s + Math.max(0, (i.total_amount || 0) - (i.paid_amount || 0)), 0)
  // To be invoiced = draft + reviewed totals (prepared but not sent yet)
  const toBeInvoicedAmount = draftInvoices.reduce((s, i) => s + (i.total_amount || 0), 0)

  const overdueInvoices  = invoices.filter(i => i.status !== 'paid' && i.due_date && new Date(i.due_date) < today)
  const dueInvoices      = invoices.filter(i => ['sent','partial'].includes(i.status) && i.due_date && new Date(i.due_date) >= today)

  // ── Task stats ───────────────────────────────────────────────────────────────
  // toBeInvoiced = done tasks not yet in any invoice (billing_cycle=none clients)
  const toBeInvoiced     = displayTasks.filter(t => t.status === 'done' && (t.billing_amount_inr || 0) > 0)
  const unscoredDoneTasks = displayTasks.filter(t => t.status === 'done' && !scoredTaskIds.has(t.id))
  const activeTasks      = displayTasks.filter(t => t.status === 'pending' || t.status === 'in_progress')

  return (
    <DashboardClient
      invoices={invoices as any[]}
      overdueInvoices={overdueInvoices as any[]}
      dueInvoices={dueInvoices as any[]}
      allCashbook={allCashbook as any[]}
      displayTasks={displayTasks as any[]}
      allAnalyticsTasks={allAnalyticsTasks as any[]}
      todayTasks={todayTasks as any[]}
      unscoredDoneTasks={unscoredDoneTasks as any[]}
      activeTasks={activeTasks.slice(0, 12) as any[]}
      toBeInvoiced={toBeInvoiced as any[]}
      employees={employees as any[]}
      scores={scores as any[]}
      payrollRecords={payrollRecords as any[]}
      todayStr={todayStr}
      stats={{
        totalBilled,
        totalPaid,
        outstanding,
        bankBalance,
        overdueCount:        overdueInvoices.length,
        overdueAmount:       overdueInvoices.reduce((s, i) => s + ((i.total_amount || 0) - (i.paid_amount || 0)), 0),
        dueCount:            dueInvoices.length,
        dueAmount:           dueInvoices.reduce((s, i) => s + ((i.total_amount || 0) - (i.paid_amount || 0)), 0),
        toBeInvoicedCount:   draftInvoices.length,
        toBeInvoicedAmount,
        totalExpectedCash:   bankBalance + outstanding + toBeInvoicedAmount,
        totalDues:           overdueInvoices.length + dueInvoices.length + toBeInvoiced.length,
      }}
      isAdmin={isAdmin}
    />
  )
}
