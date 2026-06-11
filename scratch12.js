const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: scores } = await supabase.from('contribution_scores').select('id, employee_id, earnings_inr, tasks(task_date)');
  console.log("Total rows:", scores.length);
  // group by employee and count
  const counts = {};
  scores.forEach(s => {
    if (!counts[s.employee_id]) counts[s.employee_id] = 0;
    counts[s.employee_id]++;
  });
  console.log("Counts per employee:", counts);
}
run();
