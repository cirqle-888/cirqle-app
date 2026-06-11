const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  // First, check how many new cashbook entries we created
  const { count } = await supabase.from('cashbook_entries')
    .select('*', { count: 'exact', head: true })
    .eq('notes', '[System]: Historical CSV Import');
  console.log("Number of new cashbook entries to delete:", count);
  
  // Try deleting ONE to see if it cascades to allocations
  const { data: e } = await supabase.from('cashbook_entries')
    .select('id')
    .eq('notes', '[System]: Historical CSV Import')
    .limit(1);
    
  if (e && e.length > 0) {
    const { error } = await supabase.from('cashbook_entries').delete().eq('id', e[0].id);
    if (error) {
      console.log("Delete failed:", error.message);
    } else {
      console.log("Successfully deleted 1 entry (Cascade works or no allocations attached)");
    }
  }
}
run();
