import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { count: tasksCount } = await supabase.from('tasks').select('*', { count: 'exact', head: true })
  console.log('Total tasks in db:', tasksCount)
  
  const { data: statusCounts } = await supabase.from('tasks').select('status')
  const counts = statusCounts?.reduce((acc, curr) => {
    acc[curr.status] = (acc[curr.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)
  console.log('Tasks by status:', counts)
}
main()
