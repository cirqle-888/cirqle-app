const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e } = await supabase.from('cashbook_entries')
    .select('id, amount, bank_account:bank_accounts(name), notes')
    .eq('entry_date', '2026-05-06');
    
  console.log("Entries on 2026-05-06:");
  console.log(JSON.stringify(e, null, 2));
}
run();
