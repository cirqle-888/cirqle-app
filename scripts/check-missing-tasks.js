const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, title, status, task_date')
    .in('title', ['Happy Shopping Days', 'Eid Summer Deals', 'For Us'])
  
  console.log('TASKS:', tasks)

  if (tasks?.length) {
    const { data: scores } = await supabase
      .from('contribution_scores')
      .select('*, employee:employees(cqid, name)')
      .in('task_id', tasks.map(t => t.id))
    console.log('SCORES:', JSON.stringify(scores, null, 2))
    
    const { data: contribs } = await supabase
      .from('contributions')
      .select('*, employee:employees(cqid, name)')
      .in('task_id', tasks.map(t => t.id))
    console.log('RAW CONTRIBUTIONS:', contribs?.length)
  }
}
run()
