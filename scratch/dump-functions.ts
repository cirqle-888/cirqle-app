import { Client } from 'pg';

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  });

  try {
    await client.connect();
    console.log('Connected to local database.');

    const result = await client.query(`
      SELECT proname, prosrc 
      FROM pg_proc 
      WHERE proname IN ('set_task_retainer_coverage', 'set_task_work_value')
    `);

    for (const row of result.rows) {
      console.log('=========================================');
      console.log('FUNCTION: ', row.proname);
      console.log('=========================================');
      console.log(row.prosrc);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

main();
