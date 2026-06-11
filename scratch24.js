const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e } = await supabase.from('cashbook_entries')
    .select('id, amount, amount_inr, type')
    .eq('type', 'outflow')
    .neq('notes', '[System]: Historical CSV Import')
    .limit(1);
    
  console.log("Old entry:", JSON.stringify(e, null, 2));
}
run();
