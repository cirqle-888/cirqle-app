require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  const { data: cols1 } = await supabase.rpc('get_columns_for_table', { table_name: 'payroll' });
  console.log('Payroll Columns:', cols1);
  const { data: cols2 } = await supabase.rpc('get_columns_for_table', { table_name: 'cashbook_entries' });
  console.log('Cashbook Columns:', cols2);
}
run();
