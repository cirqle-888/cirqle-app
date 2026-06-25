import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { data } = await supabase.from('tasks').select('quantity, status, task_date')
  const totalQty = data?.reduce((sum, t) => sum + (Number(t.quantity) || 1), 0)
  
  const currentMonthQty = data?.filter(t => t.task_date?.startsWith('2026-06')).reduce((sum, t) => sum + (Number(t.quantity) || 1), 0)
  
  console.log('Total Quantity (all tasks):', totalQty)
  console.log('Total Quantity (June 2026):', currentMonthQty)
  
  // also check quantity of done tasks
  const doneQty = data?.filter(t => ['done', 'invoiced', 'delivered'].includes(t.status)).reduce((sum, t) => sum + (Number(t.quantity) || 1), 0)
  console.log('Total Done Quantity:', doneQty)
}
main()
