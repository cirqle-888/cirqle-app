import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Check job 555bc456 directly
const { data: job, error: jobErr } = await supabase
  .from('system_jobs')
  .select('id, status, attempts, max_attempts, queued_at, created_at, error_log')
  .eq('id', '555bc456-7583-49d9-942e-b49a8ecbb849')
  .single()

console.log('Job 555bc456:', JSON.stringify(job, null, 2))
if (jobErr) console.error('Error fetching job:', jobErr)

// Run the same dequeue query the engine uses
console.log('\n--- Running dequeue query ---')
const { data: pending, error: fetchErr } = await supabase
  .from('system_jobs')
  .select('id, job_type, status, attempts, queued_at')
  .in('status', ['pending', 'queued'])
  .order('queued_at', { ascending: true, nullsFirst: false })
  .limit(5)

console.log(`Pending/queued jobs found: ${pending?.length ?? 0}`)
console.table(pending?.map(j => ({
  id: j.id?.slice(0, 8),
  type: j.job_type,
  status: j.status,
  attempts: j.attempts,
  queued_at: j.queued_at?.slice(11, 19) ?? 'null'
})))
if (fetchErr) console.error('Dequeue query error:', fetchErr)
