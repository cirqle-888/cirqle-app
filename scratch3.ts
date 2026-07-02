import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const { data, error } = await supabase
      .from('cashbook_entries')
      .select('id, client_id, entry_date, description, amount_inr')
      .eq('type', 'outflow')
      .is('deleted_at', null)
      .limit(1)
  console.log("Error:", error)
  console.log("Data:", data)
}
run()
