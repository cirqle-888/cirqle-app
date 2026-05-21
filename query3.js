const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const envFile = fs.readFileSync('.env.local', 'utf8');
const supabaseUrl = envFile.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const supabaseKey = envFile.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.*)/)[1].trim();
const supabase = createClient(supabaseUrl, supabaseKey);
async function run() {
  const { data } = await supabase.from('invoices').select('invoice_number, issue_date, created_at').like('invoice_number', '%010%');
  console.log(JSON.stringify(data, null, 2));
}
run();
