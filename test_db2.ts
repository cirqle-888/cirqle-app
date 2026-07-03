import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
async function test() {
  const { data } = await supabase.from('invoices').select('id, invoice_number, status, total_amount, paid_amount, client_id').eq('invoice_number', 'INV-2606-015')
  console.log('INV-2606-015:', data)
  
  const { data: d2 } = await supabase.from('invoices').select('id, invoice_number, status, total_amount, paid_amount, client_id').ilike('invoice_number', '%015%')
  console.log('All 015:', d2)
}
test()
