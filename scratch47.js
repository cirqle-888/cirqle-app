const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getQueryTable(query) {
  const t = query?.tableName ?? query?._table ?? query?.url?.pathname?.split('/').pop()
  return typeof t === 'string' && t ? t : null
}

async function fetchAll(query) {
  const allData = []
  const PAGE = 1000
  for (let page = 0; page < 100; page++) {
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) { console.error(error); break; }
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }
  return { data: allData }
}

async function run() {
  const scoresWindowFromStr = new Date(new Date().setMonth(new Date().getMonth() - 24)).toISOString();
  
  const query = supabase
    .from('contribution_scores')
    .select('task_id, employee_id, earnings_inr, calculated_at, task:tasks(id, task_date, title, status)')
    .gte('calculated_at', scoresWindowFromStr)
    .order('calculated_at', { ascending: false })
    .order('id', { ascending: true }); // like stablePaginationQuery
    
  const { data: scoresRes } = await fetchAll(query);
  
  const empId = 'f284335f-86c3-480c-a269-1705e0baf604'; // CQID002
  const monthKey = '2026-05';
  const taskId = 'dfc80470-7e34-44eb-9a2f-156df66f8ab2';

  const taskIds = new Set(
    scoresRes
      .filter(s => s.employee_id === empId && (s.task?.task_date || s.calculated_at || '').startsWith(monthKey))
      .map(s => s.task_id)
  );

  console.log("Found in taskIds?", taskIds.has(taskId));
}
run();
