import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Check status of the enqueued job
const { data, error } = await supabase
  .from('system_jobs')
  .select('id, job_type, status, queued_at, created_at, error_log')
  .eq('id', '67d37eda-f7c1-4719-9bb2-f2d9d2f33589')
  .single()

console.log('Job 67d37eda:', JSON.stringify(data, null, 2))
if (error) console.error('Error:', error)

// Also check ALL pending jobs
const { data: pending } = await supabase
  .from('system_jobs')
  .select('id, job_type, status, created_at')
  .in('status', ['pending', 'queued'])
  .order('created_at', { ascending: false })
  .limit(5)

console.log('\nAll pending/queued jobs:', pending?.length ?? 0)
console.table(pending?.map(j => ({ id: j.id?.slice(0,8), type: j.job_type, status: j.status, created: j.created_at?.slice(11,19) })))
