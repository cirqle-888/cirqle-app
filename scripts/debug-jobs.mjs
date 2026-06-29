import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Check pending jobs with all columns
const { data: jobs } = await supabase
  .from('system_jobs')
  .select('id, status, priority, queued_at, created_at, locked_by, locked_at')
  .eq('status', 'pending')
  .order('created_at', { ascending: false })
  .limit(5)

console.log('Pending jobs (with queued_at):')
console.table(jobs?.map(j => ({
  id: j.id?.slice(0,8),
  status: j.status,
  priority: j.priority,
  queued_at: j.queued_at,
  created_at: j.created_at?.slice(11,19),
  locked_by: j.locked_by?.slice(0,8) ?? null
})))

// Try calling dequeue_jobs directly
console.log('\nCalling dequeue_jobs RPC...')
const workerId = crypto.randomUUID()
const { data: dequeued, error: dqErr } = await supabase.rpc('dequeue_jobs', {
  p_worker_id: workerId,
  p_max_jobs: 5
})
if (dqErr) console.error('dequeue_jobs error:', dqErr)
else console.log('Dequeued jobs:', dequeued?.length ?? 0, dequeued)
