const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const empIds = {
    'CQID002': 'f284335f-86c3-480c-a269-1705e0baf604',
    'CQID003': '35d7945f-4a0b-465d-85fa-085eecbf8630' // Need to verify CQID003 ID
  };

  // Find CQID003
  const { data: emps } = await supabase.from('employees').select('id, cqid').in('cqid', ['CQID002', 'CQID003']);
  emps.forEach(e => empIds[e.cqid] = e.id);
  console.log("Employees:", empIds);

  const { data: tasks } = await supabase.from('tasks')
    .select('id, title, task_date, status')
    .in('title', ['Happy Shopping Days', 'Eid Summer Deals'])
    .like('task_date', '2026-05-%');

  console.log("Tasks found in May 2026:", tasks);

  if (tasks && tasks.length > 0) {
    for (const task of tasks) {
      console.log(`\n--- Task: ${task.title} (${task.id}) ---`);
      
      const { data: contribs } = await supabase.from('contributions')
        .select('employee_id, value, parameter:parameters(name)')
        .eq('task_id', task.id)
        .in('employee_id', [empIds['CQID002'], empIds['CQID003']]);
      console.log("Contributions:", contribs);

      const { data: scores } = await supabase.from('contribution_scores')
        .select('employee_id, score_percentage, earnings_inr, calculated_at')
        .eq('task_id', task.id)
        .in('employee_id', [empIds['CQID002'], empIds['CQID003']]);
      console.log("Scores:", scores);
    }
  }
}
run();
