import { createTypedAdminClient } from '../src/lib/supabase/server'
import { recalcTaskCommissions } from '../src/lib/sync/integrity'
import { refreshStoredEarningsFromBilling } from '../src/lib/sync/integrity'

async function fix() {
  const admin = createTypedAdminClient()
  
  const { data: tasks, error } = await admin.from('tasks').select('id, task_number').in('task_number', [1902, 1883, 1885, 1908, 1909])
  
  if (error) {
    console.error('Error fetching tasks:', error)
    return
  }
  
  console.log(`Found ${tasks?.length} tasks.`)
  
  for (const t of tasks || []) {
    console.log(`Recalculating task ${t.task_number} (${t.id})...`)
    const res = await recalcTaskCommissions(t.id)
    console.log(`Result for ${t.task_number}:`, res)
  }
  
  const ids = (tasks || []).map(t => t.id)
  if (ids.length > 0) {
    const { data: scores } = await admin.from('contribution_scores').select('task_id, earnings_inr').in('task_id', ids)
    console.log('New Scores:', scores)
  }
}

fix().catch(console.error)
