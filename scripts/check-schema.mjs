import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Get actual columns of system_jobs
const { data: cols } = await supabase
  .from('information_schema.columns')
  .select('column_name, data_type, column_default')
  .eq('table_name', 'system_jobs')
  .eq('table_schema', 'public')

console.log('system_jobs columns:')
console.table(cols?.map(c => ({ col: c.column_name, type: c.data_type, default: c.column_default })))

// Check one pending job raw
const { data: job, error } = await supabase
  .from('system_jobs')
  .select('*')
  .eq('status', 'pending')
  .limit(1)
  .single()

if (error) console.error('Error fetching job:', error.message)
else {
  console.log('\nSample pending job (all columns):')
  console.log(JSON.stringify(job, null, 2))
}
