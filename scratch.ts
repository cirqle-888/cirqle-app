import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { syncDraftInvoices } from './src/lib/sync/integrity'

dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const { data: tasks } = await supabase.from('tasks').select('id, status').eq('status', 'done')
  if (!tasks) return
  
  console.log(`Syncing draft invoices for ${tasks.length} done tasks...`)
  let count = 0
  for (const t of tasks) {
    try {
      await syncDraftInvoices(t.id)
      count++
    } catch(e) {
      console.error(e)
    }
  }
  console.log(`Successfully synced ${count} tasks.`)
}
run()
