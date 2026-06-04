require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function fetchAll(query) {
  const allData = []
  const PAGE = 1000
  for (let page = 0; page < 5; page++) {
    console.log('Fetching page', page, 'range', page * PAGE, (page + 1) * PAGE - 1);
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) {
      console.error('Error:', error);
      break;
    }
    console.log('Got', data.length, 'rows');
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }
  return allData;
}

async function run() {
  const q = supabase.from('payroll').select('*');
  const results = await fetchAll(q);
  console.log('Total fetched:', results.length);
}

run();
