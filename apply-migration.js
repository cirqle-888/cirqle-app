require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const { Client } = require('pg');

async function run() {
  // Try to parse Postgres connection string from NEXT_PUBLIC_SUPABASE_URL or use a direct URL
  // Actually, standard supabase-js anon key doesn't allow DDL. We need DATABASE_URL.
  if (!process.env.DATABASE_URL) {
    console.error("No DATABASE_URL found in .env.local");
    return;
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const sql = fs.readFileSync('supabase/migrations/phase9_payroll_allocations.sql', 'utf8');
  try {
    await client.query(sql);
    console.log("Migration applied successfully!");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    await client.end();
  }
}
run();
