const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: slips, error: e1 } = await supabase.from('payroll_slips').select('id').limit(1);
  console.log('Slips error:', e1);
  const { data: cashbook, error: e2 } = await supabase.from('cashbook').select('id').limit(1);
  console.log('Cashbook error:', e2);
}
run();
