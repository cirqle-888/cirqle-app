import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const { data: entries } = await supabase.from('cashbook_entries').select('id, type, amount, amount_inr, entry_date, description, client_id, client:clients(name)').ilike('description', '%Mezza%').order('entry_date', { ascending: false })
  console.log(JSON.stringify(entries, null, 2))
}
run()
