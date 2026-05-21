const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data: inv } = await supabase.from('invoices').select('*').eq('invoice_number', 'INV-2510-034').single();
  console.log('Invoice:', inv);
  
  const { data: cb } = await supabase.from('cashbook_entries').select('*').ilike('reference', '%INV-2510-034%');
  console.log('Cashbook entries:', cb);
}
check();
