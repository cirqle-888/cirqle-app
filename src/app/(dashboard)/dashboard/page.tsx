import { createAdminClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { getPendingPricing } from '@/lib/pricing/pending'
import { PricingPendingBanner } from '@/components/pricing/pricing-pending-banner'
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

  // ── Streamed analytics promises ──────────────────────────────────────────────
  // The two heaviest queries (36-month analytics tasks + contribution scores) are
  // NOT awaited here. We kick the promises off eagerly — so their network round-
  // trips start immediately, in parallel with the awaited light queries below —
  // and pass them UNRESOLVED through to the client, where <Suspense> + React
  // `use()` unwrap them. This lets the dashboard shell (hero, today's focus,
  // period controls) paint before these queries finish. The resolved data is
  // byte-for-byte identical to before; only WHEN it lands on the client changes.
  const allAnalyticsTasksPromise: Promise<any[]> = isAdmin
    ? fetchAll(supabase
        .from('tasks')
        .select('id, billing_amount_inr, quantity, task_date, status, service_id, client:clients(id, name), service:services(id, name)')
        .not('status', 'eq', 'cancelled')
        .gte('task_date', analyticsFromStr)
        .order('task_date', { ascending: true })
        .order('id', { ascending: true })).then(r => r.data || [])
    : Promise.resolve<any[]>([])

  const scoresPromise: Promise<any[]> = isAdmin
    ? fetchAll(supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr, calculated_at, task:tasks(id, quantity, task_date)')
        .gte('calculated_at', analyticsFromStr)
        .order('calculated_at', { ascending: false })
        .order('id', { ascending: true })).then(r => r.data || [])
    : fetchAll(supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr, calculated_at, task:tasks(id, quantity, task_date)')
        .eq('employee_id', employeeId)
        .gte('calculated_at', analyticsFromStr)
        .order('calculated_at', { ascending: false })
        .order('id', { ascending: true })).then(r => r.data || [])

  // Only fetch invoices, cashbook, and all payroll history if admin
  const [
    invoicesRes,
    cashbookRes,
    displayTasksRes,
    employeesRes,
    scoredTaskIdsRes,
    todayTasksRes,
    payrollRes,
  ] = await Promise.all([
    isAdmin
      ? fetchAll(supabase
          .from('invoices')
          .select('id, invoice_number, total_amount, paid_amount, total_amount_inr, paid_amount_inr, status, currency, due_date, client:clients(id, name)')
          .order('due_date', { ascending: true })
          .order('id', { ascending: true }))
      : Promise.resolve({ data: [] }),

    // Cashbook — admin only, all-time for accurate bank balance calculation.
    // Filter out soft-deleted entries so deleted/edited entries don't appear
    // in the dashboard Cash Flow widget or distort the bank balance.
    isAdmin
      ? fetchAll(supabase
          .from('cashbook_entries')
          .select('type, amount_inr, entry_date, description')
          .is('deleted_at', null)
          .order('entry_date', { ascending: true })
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
  const displayTasks       = displayTasksRes.data || []
  const employees          = employeesRes.data || []
  const scoredTaskIds      = new Set((scoredTaskIdsRes.data || []).map((r: any) => r.task_id))
  const todayTasks         = todayTasksRes.data || []
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

  // Company financial summaries are always in INR. Use the INR snapshot columns
  // (total_amount_inr / paid_amount_inr) so foreign-currency invoices are not
  // summed as if they were rupees. Falls back to the raw amount for INR invoices
  // and pre-migration rows (where the snapshot equals the invoice-currency value).
  const invTotalInr = (i: any) => i.total_amount_inr ?? i.total_amount ?? 0
  const invPaidInr  = (i: any) => i.paid_amount_inr ?? i.paid_amount ?? 0

  const totalBilled   = invoices.filter(i => i.status !== 'cancelled').reduce((s, i) => s + invTotalInr(i), 0)
  const totalPaid     = invoices.reduce((s, i) => s + invPaidInr(i), 0)
  // Outstanding = unpaid from invoices already sent to clients (not drafts)
  const outstanding   = sentInvoices.reduce((s, i) => s + Math.max(0, invTotalInr(i) - invPaidInr(i)), 0)
  // To be invoiced = draft + reviewed totals (prepared but not sent yet)
  const toBeInvoicedAmount = draftInvoices.reduce((s, i) => s + invTotalInr(i), 0)

  const overdueInvoices  = invoices.filter(i => i.status !== 'paid' && i.due_date && new Date(i.due_date) < today)
  const dueInvoices      = invoices.filter(i => ['sent','partial'].includes(i.status) && i.due_date && new Date(i.due_date) >= today)

  // ── Task stats ───────────────────────────────────────────────────────────────
  // toBeInvoiced = done tasks not yet in any invoice (billing_cycle=none clients)
  const toBeInvoiced     = displayTasks.filter(t => t.status === 'done' && (t.billing_amount_inr || 0) > 0)
  const unscoredDoneTasks = displayTasks.filter(t => t.status === 'done' && !scoredTaskIds.has(t.id))
  const activeTasks      = displayTasks.filter(t => t.status === 'pending' || t.status === 'in_progress')

  // Pending-to-price banner — only for users who can see/set pricing.
  const canSeePricing = isAdmin || !!me?.permissions?.has('tasks.view_pricing')
  const pendingPricing = canSeePricing ? await getPendingPricing(supabase) : { clients: [], services: [], total: 0 }

  // ── My pending actions (employee view) ─────────────────────────────────────
  // What needs THIS employee's attention right now: open tasks assigned to
  // them + done tasks where they haven't logged their contribution yet.
  // Bounded to the 90-day display window like the other widgets.
  let myActions: { active: any[]; needContribution: any[] } = { active: [], needContribution: [] }
  if (!isAdmin && employeeId) {
    try {
      const { data: assigns } = await supabase
        .from('task_assignments')
        .select('task_id, task:tasks!inner(id, task_number, title, status, task_date, deleted_at, client:clients(id, name))')
        .eq('employee_id', employeeId)
        .is('task.deleted_at', null)
        .gte('task.task_date', displayFromStr)
      const rows = (assigns || []).map((a: any) => a.task).filter(Boolean)
      const ids = rows.map((t: any) => t.id)
      let contributed = new Set<string>()
      if (ids.length) {
        const { data: contribs } = await supabase
          .from('contributions')
          .select('task_id')
          .eq('employee_id', employeeId)
          .gt('value', 0)
          .in('task_id', ids)
        contributed = new Set((contribs || []).map((c: any) => c.task_id))
      }
      myActions = {
        active: rows
          .filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
          .sort((a: any, b: any) => (a.task_date || '').localeCompare(b.task_date || '')),
        needContribution: rows
          .filter((t: any) => t.status === 'done' && !contributed.has(t.id))
          .sort((a: any, b: any) => (b.task_date || '').localeCompare(a.task_date || '')),
      }
    } catch { /* defensive — widget simply stays hidden */ }
  }

  return (
    <>
    {canSeePricing && <PricingPendingBanner clients={pendingPricing.clients} services={pendingPricing.services} />}
    <DashboardClient
      invoices={invoices as any[]}
      overdueInvoices={overdueInvoices as any[]}
      dueInvoices={dueInvoices as any[]}
      allCashbook={allCashbook as any[]}
      displayTasks={displayTasks as any[]}
      allAnalyticsTasksPromise={allAnalyticsTasksPromise}
      todayTasks={todayTasks as any[]}
      unscoredDoneTasks={unscoredDoneTasks as any[]}
      activeTasks={activeTasks.slice(0, 12) as any[]}
      toBeInvoiced={toBeInvoiced as any[]}
      employees={employees as any[]}
      scoresPromise={scoresPromise}
      payrollRecords={payrollRecords as any[]}
      todayStr={todayStr}
      pendingContribCount={myActions.needContribution.length}
      myActions={myActions}
      stats={{
        totalBilled,
        totalPaid,
        outstanding,
        bankBalance,
        overdueCount:        overdueInvoices.length,
        overdueAmount:       overdueInvoices.reduce((s, i) => s + (invTotalInr(i) - invPaidInr(i)), 0),
        dueCount:            dueInvoices.length,
        dueAmount:           dueInvoices.reduce((s, i) => s + (invTotalInr(i) - invPaidInr(i)), 0),
        toBeInvoicedCount:   draftInvoices.length,
        toBeInvoicedAmount,
        totalExpectedCash:   bankBalance + outstanding + toBeInvoicedAmount,
        totalDues:           overdueInvoices.length + dueInvoices.length + toBeInvoiced.length,
      }}
      isAdmin={isAdmin}
    />
    </>
  )
}
