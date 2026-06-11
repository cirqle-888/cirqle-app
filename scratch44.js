const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const currentYear = new Date().getFullYear();
  const scoresWindowFrom = new Date();
  scoresWindowFrom.setMonth(scoresWindowFrom.getMonth() - 24);
  const scoresWindowFromStr = scoresWindowFrom.toISOString();

  const { data: scoresRes } = await supabase
    .from('contribution_scores')
    .select('task_id, employee_id, earnings_inr, calculated_at, task:tasks(id, task_date, title, status)')
    .gte('calculated_at', scoresWindowFromStr)
    .order('calculated_at', { ascending: false });

  const { data: tasksRes } = await supabase
    .from('tasks')
    .select('id, title, task_date, status, client:clients(name), service:services(name)')
    .in('status', ['done', 'delivered', 'invoiced', 'paid'])
    .gte('task_date', `${currentYear - 1}-01-01`)
    .order('task_date', { ascending: false });

  const empId = 'f284335f-86c3-480c-a269-1705e0baf604'; // CQID002
  const monthKey = '2026-05';
  const taskId = 'dfc80470-7e34-44eb-9a2f-156df66f8ab2';

  const taskIds = new Set(
    scoresRes
      .filter(s => s.employee_id === empId && (s.task?.task_date || s.calculated_at || '').startsWith(monthKey))
      .map(s => s.task_id)
  );

  console.log("taskIds has taskId:", taskIds.has(taskId));
  console.log("tasksRes has taskId:", tasksRes.some(t => t.id === taskId));
  
  const empTasks = tasksRes.filter(t => taskIds.has(t.id));
  console.log("empTasks has taskId:", empTasks.some(t => t.id === taskId));
  
  const foundTask = empTasks.find(t => t.id === taskId);
  if (foundTask) console.log("Task title:", foundTask.title);
}
run();
