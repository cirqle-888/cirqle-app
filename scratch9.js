const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: c } = await supabase.from('cashbook_entries').select('id, entry_date, amount_inr').eq('type', 'expense');
  console.log('Cashbook entries (expenses):', c?.length);
}
run();
