const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: scoresRes } = await supabase
    .from('contribution_scores')
    .select('calculated_at')
    .order('calculated_at', { ascending: false })
    .limit(1000);
    
  console.log("Total rows:", scoresRes.length);
  console.log("Last row calculated_at:", scoresRes[scoresRes.length - 1].calculated_at);
}
run();
