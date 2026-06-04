require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('cashbook_invoice_allocations').select('*').limit(1);
  console.log("cashbook_invoice_allocations exists:", !error);
  
  // Try querying cashbook_payroll_allocations to see if it exists
  const { error: err2 } = await supabase.from('cashbook_payroll_allocations').select('*').limit(1);
  console.log("cashbook_payroll_allocations exists:", !err2);
  if (err2) console.log(err2.message);
}
run();
