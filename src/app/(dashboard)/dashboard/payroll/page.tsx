import { createClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import PayrollClient from './payroll-client'

export const dynamic = 'force-dynamic'

export default async function PayrollPage() {
  const supabase = await createClient()
  const now = new Date()
  const currentYear = now.getFullYear()

  const [employeesRes, payrollRes, advancesRes, creditRes, deductionsRes, scoresRes, tasksRes] = await Promise.all([
    fetchAll(stablePaginationQuery(
      supabase.from('employees').select('*').order('cqid')
    )),
    fetchAll(stablePaginationQuery(
      supabase
        .from('payroll')
        .select('*, employee:employees(id, cqid, name)')
        .order('year', { ascending: false })
        .order('month', { ascending: false })
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
    // Include task_id so we can detect missing contributions
    fetchAll(stablePaginationQuery(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, earnings_inr, calculated_at, task:tasks(id, task_date, title, status)')
        .order('calculated_at', { ascending: false })
    )),
    // Done/delivered tasks for missing-contributions detection
    fetchAll(stablePaginationQuery(
      supabase
        .from('tasks')
        .select('id, title, task_date, status, client:clients(name), service:services(name)')
        .in('status', ['done', 'delivered', 'invoiced', 'paid'])
        .gte('task_date', `${currentYear - 1}-01-01`)
        .order('task_date', { ascending: false })
    )),
  ])


  return (
    <PayrollClient
      employees={employeesRes.data || []}
      payrollRecords={payrollRes.data || []}
      advances={advancesRes.data || []}
      credits={creditRes.data || []}
      deductions={deductionsRes.data || []}
      contributionScores={(scoresRes.data || []) as any[]}
      allTasks={(tasksRes.data || []) as any[]}
    />
  )
}
