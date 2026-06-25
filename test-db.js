import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  const { data: offers, error: err1 } = await supabase.from('offer_campaigns').select('*, client:clients(name)').order('created_at', { ascending: false }).limit(5)
  console.log("RECENT OFFERS:")
  console.log(JSON.stringify(offers, null, 2))

  const { data: reqs, error: err2 } = await supabase.from('task_requests').select('id, title, kind, source, status').order('created_at', { ascending: false }).limit(5)
  console.log("RECENT REQUESTS:")
  console.log(JSON.stringify(reqs, null, 2))
}

run()
