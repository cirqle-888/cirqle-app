const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log("Starting cleanup...");
  
  // 1. Delete all duplicates created by my script
  const { data: duplicates, error: err1 } = await supabase.from('cashbook_entries')
    .select('id')
    .eq('notes', '[System]: Historical CSV Import');
    
  if (err1) throw err1;
  
  if (duplicates.length > 0) {
    const idsToDelete = duplicates.map(d => d.id);
    const { error: err2 } = await supabase.from('cashbook_entries').delete().in('id', idsToDelete);
    if (err2) throw err2;
    console.log(`Deleted ${duplicates.length} duplicate cashbook entries.`);
  } else {
    console.log("No duplicates found to delete.");
  }

  console.log("Cleanup complete!");
}

run().catch(console.error);
