const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: scores } = await supabase.from('contribution_scores').select('employee_id, earnings_inr, tasks(task_date)');
  console.log('Total scores:', scores?.length);
  let sum = 0;
  scores.forEach(s => sum += s.earnings_inr);
  console.log('Total earnings:', sum);
}
run();
