const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: bankAccounts, error: e1 } = await supabase.from('bank_accounts').select('id').limit(1);
  console.log("bankAccounts:", bankAccounts, "error:", e1);
  
  const { data: categories, error: e2 } = await supabase.from('transaction_categories').select('id').limit(1);
  console.log("categories:", categories, "error:", e2);
}
run();
