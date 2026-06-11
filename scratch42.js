const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const empId = 'f284335f-86c3-480c-a269-1705e0baf604'; // CQID002
  const monthKey = '2026-05';
  const taskId = 'dfc80470-7e34-44eb-9a2f-156df66f8ab2';

  const { data: scoresRes } = await supabase
    .from('contribution_scores')
    .select('task_id, employee_id, earnings_inr, calculated_at, task:tasks(id, task_date, title, status)')
    .eq('task_id', taskId);

  console.log("scoresRes for this task:");
  console.log(JSON.stringify(scoresRes, null, 2));

  const filtered = scoresRes.filter(s => s.employee_id === empId && (s.task?.task_date || s.calculated_at || '').startsWith(monthKey));
  console.log("filtered length:", filtered.length);
}
run();
