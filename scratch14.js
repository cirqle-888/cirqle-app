const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: p } = await supabase.from('payroll').select('*').eq('payslip_number', 'PAY-002-0626');
  console.log("Existing payslip for PAY-002-0626:", p);
}
run();
