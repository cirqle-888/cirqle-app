require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  const { data: cols1, error: err1 } = await supabase.from('payroll').select('*').limit(1);
  console.log('Payroll Columns:', err1 || (cols1[0] ? Object.keys(cols1[0]) : 'empty'));
  const { data: cols2, error: err2 } = await supabase.from('cashbook_entries').select('*').limit(1);
  console.log('Cashbook Columns:', err2 || (cols2[0] ? Object.keys(cols2[0]) : 'empty'));
}
run();
