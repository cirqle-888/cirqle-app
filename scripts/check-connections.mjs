import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Raw select * to see actual columns and data
const { data, error } = await supabase
  .from('provider_connections')
  .select('*')
  .limit(10)

if (error) {
  console.error('Error:', JSON.stringify(error, null, 2))
} else {
  console.log(`provider_connections rows: ${data?.length ?? 0}`)
  if (data?.length > 0) {
    console.log('Columns:', Object.keys(data[0]))
    data.forEach(r => {
      const { access_token, ...safe } = r
      console.log({ ...safe, access_token: access_token?.slice(0, 20) + '...' })
    })
  }
}
