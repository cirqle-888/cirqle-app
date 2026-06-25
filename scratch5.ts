import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const query = supabase.from('contribution_scores').select('id').order('id', { ascending: true })
  
  const { data: d1 } = await query.range(0, 9)
  console.log('d1 len:', d1?.length, 'first:', d1?.[0]?.id)
  
  const { data: d2 } = await query.range(10, 19)
  console.log('d2 len:', d2?.length, 'first:', d2?.[0]?.id)
  
  const { data: d3 } = await query.range(0, 9)
  console.log('d3 len:', d3?.length, 'first:', d3?.[0]?.id)
}
main()
