const { createClient } = require('@supabase/supabase-js')
require('dotenv').config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

async function fetchAll(query) {
  const allData = []
  const PAGE = 1000
  for (let page = 0; page < 100; page++) {
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) break
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }
  return { data: allData }
}

async function run() {
  const { data: empData } = await supabase.from('employees').select('id, cqid').eq('cqid', 'CQID001').single()
  const empId = empData.id

  const q = supabase
      .from('contribution_scores')
      .select('*, task:tasks(id, title, task_date, billing_amount_inr, service_id, client:clients(id, name))')
      .order('calculated_at', { ascending: false })
      .order('id', { ascending: true }) // <-- STABLE PAGINATION
      
  const { data: scores } = await fetchAll(q)
  
  const empScores = scores.filter(s => s.employee_id === empId)

  const total = empScores.reduce((sum, s) => sum + (s.earnings_inr || 0), 0)
  
  console.log(`UI Logic Simulation (Stable Pagination):`)
  console.log(`Total empScores length: ${empScores.length}`)
  console.log(`Total Earnings: ${total}`)
}
run()
