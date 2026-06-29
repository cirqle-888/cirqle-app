import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()
const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Check which tables exist
const tables = ['clients', 'ad_projects', 'ad_daily_metrics', 'ad_reports', 'client_branding', 'ad_report_schedules', 'ad_report_analytics', 'companies']
console.log('=== Table Existence Check ===')
for (const table of tables) {
  const { error } = await supabase.from(table).select('id').limit(0)
  console.log(`${table}: ${error ? 'NOT FOUND - ' + error.message : 'EXISTS'}`)
}

// Check columns on clients table
console.log('\n=== clients columns ===')
const { data: clientRow } = await supabase.from('clients').select('*').limit(1)
if (clientRow?.[0]) console.log(Object.keys(clientRow[0]).join(', '))
else console.log('(no rows, check via information_schema)')

// Check columns on ad_projects
console.log('\n=== ad_projects columns ===')
const { data: projRow } = await supabase.from('ad_projects').select('*').limit(1)
if (projRow?.[0]) console.log(Object.keys(projRow[0]).join(', '))
