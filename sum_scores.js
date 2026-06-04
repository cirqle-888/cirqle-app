const { createClient } = require('@supabase/supabase-js')
require('dotenv').config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

async function run() {
  const { data: empData } = await supabase.from('employees').select('id, cqid').eq('cqid', 'CQID001').single()
  if (!empData) return console.log('Emp not found')
  const empId = empData.id

  let allScores = []
  for (let page = 0; page < 10; page++) {
    const { data } = await supabase.from('contribution_scores').select('task_id, earnings_inr').eq('employee_id', empId).range(page * 1000, (page + 1) * 1000 - 1)
    if (!data || data.length === 0) break
    allScores.push(...data)
  }

  const total = allScores.reduce((sum, s) => sum + s.earnings_inr, 0)
  console.log(`CQID001 Total Earnings: ${total}`)
  console.log(`Total Tasks: ${allScores.length}`)
  
  // Also check if any are null/NaN
  const nulls = allScores.filter(s => s.earnings_inr == null || isNaN(s.earnings_inr))
  console.log(`Nulls/NaNs: ${nulls.length}`)
}
run()
