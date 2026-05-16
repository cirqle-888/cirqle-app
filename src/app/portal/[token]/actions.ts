'use server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function submitContributions(
  token: string,
  taskId: string,
  contributions: { parameter_id: string; value: number }[]
) {
  const supabase = createAdminClient()

  // Validate token
  const { data: employee } = await supabase
    .from('employees')
    .select('id')
    .eq('portal_token', token)
    .single()

  if (!employee) throw new Error('Invalid portal token')

  // Validate assignment
  const { data: assignment } = await supabase
    .from('task_assignments')
    .select('task_id')
    .eq('task_id', taskId)
    .eq('employee_id', employee.id)
    .single()

  if (!assignment) throw new Error('Not assigned to this task')

  // Upsert contributions (delete old ones for this task/employee, insert new)
  await supabase.from('contributions')
    .delete()
    .eq('task_id', taskId)
    .eq('employee_id', employee.id)

  if (contributions.length > 0) {
    const inserts = contributions
      .filter(c => c.value > 0)
      .map(c => ({
        task_id: taskId,
        employee_id: employee.id,
        parameter_id: c.parameter_id,
        value: c.value,
      }))
    if (inserts.length > 0) {
      await supabase.from('contributions').insert(inserts)
    }
  }

  return { success: true }
}
