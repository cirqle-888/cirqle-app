const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: payroll, error: e1 } = await supabase.from('payroll').select('*').limit(1);
  console.log('Payroll:', payroll);
  const { data: cashbook, error: e2 } = await supabase.from('cashbook_entries').select('*').limit(1);
  console.log('Cashbook:', cashbook);
}
run();
