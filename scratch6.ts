import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const { data, error } = await supabase
    .from('invoice_expense_items')
    .select('*')
    .eq('invoice_id', '74c84230-c671-4456-b7b4-4fec789d40e7')
  console.log("Error:", error)
  console.log("Expense items for invoice:", data?.length)
}
run()
