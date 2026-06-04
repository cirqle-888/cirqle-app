require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.rpc('get_tables'); // Or maybe run raw query?
  if (error) {
    console.log("RPC get_tables failed. Trying alternative.");
    const { data: qData, error: qErr } = await supabase.from('cashbook_entries').select('id, allocations:cashbook_invoice_allocations(*)').limit(1);
    if(qErr) console.log(qErr.message);
    else console.log(qData);
  } else {
    console.log(data);
  }
}
run();
