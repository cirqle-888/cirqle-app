import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function run() {
  console.log('Fetching employees with auth_id...')
  const { data: employees, error } = await supabase.from('employees').select('id, cqid, auth_id').not('auth_id', 'is', null)
  if (error) {
    console.error('Error fetching employees:', error)
    return
  }
  console.log(`Found ${employees.length} employees with auth_id.`)

  for (const emp of employees) {
    // Check if auth_id exists in auth.users
    const { data: user, error: userError } = await supabase.auth.admin.getUserById(emp.auth_id)
    if (userError || !user) {
      console.log(`Employee ${emp.cqid} (${emp.id}) has orphaned auth_id: ${emp.auth_id}. Clearing...`)
      const { error: updateError } = await supabase.from('employees').update({ auth_id: null }).eq('id', emp.id)
      if (updateError) {
        console.error(`Failed to clear auth_id for ${emp.cqid}:`, updateError)
      } else {
        console.log(`Successfully cleared auth_id for ${emp.cqid}`)
      }
    }
  }
  console.log('Done.')
}

run()
