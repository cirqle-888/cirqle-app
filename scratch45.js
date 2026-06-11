const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const scoresWindowFrom = new Date();
  scoresWindowFrom.setMonth(scoresWindowFrom.getMonth() - 24);
  const scoresWindowFromStr = scoresWindowFrom.toISOString();

  const { data: scoresRes } = await supabase
    .from('contribution_scores')
    .select('task_id, employee_id, earnings_inr, calculated_at')
    .eq('task_id', 'dfc80470-7e34-44eb-9a2f-156df66f8ab2')
    .gte('calculated_at', scoresWindowFromStr);

  console.log("Found in large query without fetchAll:", scoresRes);
}
run();
