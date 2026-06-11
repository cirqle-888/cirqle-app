require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY); // wait, need service role key to delete if RLS is on

async function run() {
  // Let's use service_role key to bypass RLS, or see if anon key works
  const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  
  // try to soft delete first
  const { data: cols, error: colErr } = await adminClient.from('cashbook_payroll_allocations').select('*').limit(1);
  if (colErr) { console.error("Error accessing table:", colErr); return; }
  
  const hasDeletedAt = cols.length > 0 && cols[0].hasOwnProperty('deleted_at');
  
  if (hasDeletedAt) {
    const { data, error } = await adminClient.from('cashbook_payroll_allocations').update({ deleted_at: new Date().toISOString() }).filter('deleted_at', 'is', null).select('id');
    console.log("Soft deleted:", data?.length, error);
  } else {
    // try to hard delete
    const { data, error } = await adminClient.from('cashbook_payroll_allocations').delete().neq('id', '00000000-0000-0000-0000-000000000000').select('id');
    console.log("Hard deleted:", data?.length, error);
  }
}
run();
