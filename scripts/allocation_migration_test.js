const { execSync } = require('child_process');

function runQuery(query) {
  try {
    const cmd = `npx supabase db query "${query}" --linked`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    return output.trim();
  } catch (error) {
    console.error('Query failed:', error.message);
    if (error.stdout) console.log(error.stdout);
    if (error.stderr) console.error(error.stderr);
    process.exit(1);
  }
}

async function verify() {
  console.log('=== Pre-Flight Verification ===');
  
  // Snapshot invoice balances
  const preInvoicesCsv = runQuery(`
    SELECT id, invoice_number, paid_amount, status 
    FROM invoices 
    WHERE paid_amount > 0 
    ORDER BY invoice_number;
  `);
  console.log(`Found invoices with payments before migration.\n`);

  console.log('=== Running Phase 3, 4, 5 SQL ===');
  try {
    console.log('Running Phase 3 (Schema)...');
    execSync(`npx supabase db query -f supabase/migrations/phase3_allocations.sql --linked`, {stdio: 'inherit'});
    
    console.log('Running Phase 4 (Triggers)...');
    execSync(`npx supabase db query -f supabase/migrations/phase4_allocation_triggers.sql --linked`, {stdio: 'inherit'});
    
    console.log('Running Phase 5 (Data Migration)...');
    execSync(`npx supabase db query -f supabase/migrations/phase5_allocation_data_migration.sql --linked`, {stdio: 'inherit'});
  } catch (err) {
    console.error('Migration failed!', err.message);
    process.exit(1);
  }

  console.log('\n=== Post-Flight Verification ===');
  // Snapshot invoice balances again
  const postInvoicesCsv = runQuery(`
    SELECT id, invoice_number, paid_amount, status 
    FROM invoices 
    WHERE paid_amount > 0 
    ORDER BY invoice_number;
  `);

  if (preInvoicesCsv === postInvoicesCsv) {
    console.log('✅ ZERO-DIFFERENCE VERIFICATION PASSED!');
    console.log('All invoice paid amounts and statuses perfectly match the pre-flight state.');
  } else {
    console.error('❌ VERIFICATION FAILED! Differences detected.');
    console.log('-- Pre --\n', preInvoicesCsv);
    console.log('-- Post --\n', postInvoicesCsv);
  }
}

verify();
