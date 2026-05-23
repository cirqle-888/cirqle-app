import { createClient, fetchAll } from '@/lib/supabase/server'
import ReportsClient from './reports-client'

// Always fetch fresh data — scores get written when contributions are saved
export const dynamic = 'force-dynamic'

export default async function ReportsPage() {
  const supabase = await createClient()

  const [employeesRes, scoresRes, tasksRes] = await Promise.all([
    supabase.from('employees').select('id, cqid, name, performance_rating').eq('is_active', true).order('cqid'),
    fetchAll(supabase
      .from('contribution_scores')
      .select('*, task:tasks(id, title, task_date, billing_amount_inr, service_id, client:clients(id, name))')
      .order('calculated_at', { ascending: false })
      .order('id', { ascending: true })),
    fetchAll(supabase
      .from('tasks')
      .select('id, title, task_date, status, billing_amount_inr, service_id, client:clients(id, name)')
      .order('task_date', { ascending: false })
      .order('id', { ascending: true })),
  ])

  return (
    <ReportsClient
      employees={employeesRes.data || []}
      scores={(scoresRes.data || []) as any[]}
      tasks={(tasksRes.data || []) as any[]}
    />
  )
}
