const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: p } = await supabase.from('payroll').select('*').limit(1);
  console.log('Payroll:', p);
  const { data: c } = await supabase.from('cashbook_entries').select('*').limit(1);
  console.log('Cashbook:', c);
}
run();
