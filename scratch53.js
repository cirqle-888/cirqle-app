const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('payroll').select('*').limit(1);
  if (data && data.length > 0) {
    console.log("Payroll Columns:", Object.keys(data[0]));
  } else {
    console.log("No data found, but no error:", error);
  }
}
run();
