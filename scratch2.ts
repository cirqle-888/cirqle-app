import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { data } = await supabase.from('cashbook_entries').select('*').in('id', ['a8c1868e-f4a7-401d-9f35-84dcb2c3e60b', 'a625b6a0-303b-4771-a651-a5c18f3bc06b'])
  console.log(data)
}
main()
