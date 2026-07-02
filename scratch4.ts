import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const ids = ['faaa93a2-ec86-41ae-b936-6841025981ec', 'bc367193-abdc-4fb0-bb16-dad4cce5b534']
  const { data, error } = await supabase
      .from('invoice_expense_items')
      .select('cashbook_entry_id, invoice:invoices(id, status)')
      .in('cashbook_entry_id', ids)
  console.log("Error:", error)
  console.log("Data:", JSON.stringify(data, null, 2))
}
run()
