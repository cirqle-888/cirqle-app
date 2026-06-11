const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: c } = await supabase.from('cashbook_categories').select('*');
  const salaries = c.filter(cat => cat.name.toLowerCase().includes('salary'));
  console.log("Salary categories:", JSON.stringify(salaries, null, 2));
}
run();
