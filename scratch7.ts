import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const invCur = 'INR'
  const invRate = 1
  const e = { id: 'faaa93a2-ec86-41ae-b936-6841025981ec', amount_inr: 500, description: 'Test' }
  const amtInInvCur = 500

  const row = {
    invoice_id: '74c84230-c671-4456-b7b4-4fec789d40e7',
    cashbook_entry_id: e.id,
    description: e.description || 'Expense',
    amount: amtInInvCur,
    amount_inr: e.amount_inr,
    currency: invCur,
    original_amount: amtInInvCur,
    original_amount_inr: e.amount_inr,
    markup_type: 'none',
    markup_value: 0,
    markup_amount: 0,
  }
  const { error } = await supabase.from('invoice_expense_items').insert([row])
  console.log("Insert Error:", JSON.stringify(error, null, 2))
}
run()
