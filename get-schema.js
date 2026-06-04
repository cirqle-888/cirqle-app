require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  // Try to query cashbook_entries columns
  const { data: cols, error } = await supabase.rpc('get_columns_for_table', { table_name: 'cashbook_entries' });
  if (error) {
    // Fallback: fetch one row to see columns
    const { data } = await supabase.from('cashbook_entries').select('*').limit(1);
    console.log('Cashbook Columns:', data ? Object.keys(data[0] || {}) : 'No data');
  } else {
    console.log('Cashbook Columns:', cols);
  }
}
run();
