const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  // 1. Get the employee CQID002
  const { data: emp, error: empErr } = await supabase.from('employees').select('*').eq('cqid', 'CQID002').single();
  if (empErr) {
    console.error("Error finding employee:", empErr.message);
    return;
  }
  
  if (!emp.email) {
    console.error("CQID002 has no email set in employees table.");
    return;
  }
  
  console.log(`Found CQID002 with email: ${emp.email}`);
  
  // 2. Find the user in auth.users by email
  const { data: { users }, error: authErr } = await supabase.auth.admin.listUsers();
  if (authErr) {
    console.error("Error listing users:", authErr.message);
    return;
  }
  
  const targetUser = users.find(u => u.email === emp.email);
  if (!targetUser) {
    console.log(`No Auth user found for email ${emp.email}.`);
    return;
  }
  
  console.log(`Found Auth user ${targetUser.id} for email ${emp.email}.`);
  
  // 3. Link them!
  const { error: updateErr } = await supabase.from('employees').update({ auth_id: targetUser.id }).eq('id', emp.id);
  if (updateErr) {
    console.error("Error updating employee auth_id:", updateErr.message);
  } else {
    console.log("Successfully linked auth_id to CQID002!");
  }
}

run();
