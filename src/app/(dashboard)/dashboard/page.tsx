import { createClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import DashboardClient from './dashboard-client'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = await createClient()

  const todayStr = new Date().toISOString().slice(0, 10)

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
    fetchAll(supabase
      .from('invoices')
      .select('id, invoice_number, total_amount, paid_amount, status, currency, due_date, client:clients(id, name)')
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })),

    // ALL cashbook — for bank balance, trends, weekday analysis
    fetchAll(supabase
      .from('cashbook_entries')
      .select('type, amount_inr, entry_date, description')
      .order('entry_date', { ascending: true })
      .order('id', { ascending: true })),

    // ALL tasks for analytics (no status filter, no limit)
    fetchAll(supabase
      .from('tasks')
      .select('id, billing_amount_inr, task_date, status, service_id, client:clients(id, name), service:services(id, name)')
      .not('status', 'eq', 'cancelled')
      .order('task_date', { ascending: true })
      .order('id', { ascending: true })),

    // Recent tasks for display widgets
    fetchAll(stablePaginationQuery(supabase
      .from('tasks')
      .select('id, title, status, billing_amount_inr, task_date, client:clients(id, name), service:services(id, name)')
      .not('status', 'eq', 'cancelled')
      .order('task_date', { ascending: false }))),

    fetchAll(stablePaginationQuery(supabase
      .from('employees')
      .select('id, cqid, name, performance_rating, role')
      .eq('is_active', true)
      .order('cqid'))),

    fetchAll(stablePaginationQuery(supabase.from('contribution_scores').select('task_id').order('id', { ascending: true }))),

    supabase
      .from('tasks')
      .select('id, title, status, billing_amount_inr, task_date, client:clients(id, name), service:services(id, name)')
      .eq('task_date', todayStr)
      .order('status'),

    fetchAll(supabase
      .from('contribution_scores')
      .select('employee_id, earnings_inr, calculated_at, task:tasks(task_date)')
      .order('calculated_at', { ascending: false })
      .order('id', { ascending: true })),

    // Payroll for Jobs vs Payroll table
    supabase
      .from('payroll')
      .select('month, year, base_salary, commission_earned, net_salary, status')
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(24),
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
    />
  )
}
