const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const taskIds = [
    '088e3ba5-bdf4-4e48-921b-fb98e7c69af8', // Happy Shopping Days
    '31226d88-56e9-47dc-99e2-ce4aa57a36ae'  // Eid Summer Deals
  ];
  
  for (const taskId of taskIds) {
    console.log(`\n--- Task ID: ${taskId} ---`);
    const { data: c } = await supabase.from('contributions')
      .select('employee_id, value, parameter_id')
      .eq('task_id', taskId);
    console.log("Contributions:", c);

    const { data: s } = await supabase.from('contribution_scores')
      .select('employee_id, score_percentage, earnings_inr, calculated_at')
      .eq('task_id', taskId);
    console.log("Scores:", s);
  }
}
run();
