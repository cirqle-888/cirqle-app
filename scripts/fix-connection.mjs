import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// 1. List all provider_connections
const { data: conns } = await supabase
  .from('provider_connections')
  .select('id, provider, status, client_id, expires_at, created_at')
  .order('created_at', { ascending: false })

console.log('All provider_connections:')
console.table(conns?.map(c => ({
  id: c.id?.slice(0, 8),
  provider: c.provider,
  status: c.status,
  client_id: c.client_id?.slice(0, 8),
  expires_at: c.expires_at?.slice(0, 10)
})))

// 2. Find the Meta connection
const metaConn = conns?.find(c => c.provider === 'meta')
if (!metaConn) {
  console.log('\nNo Meta connection found!')
  process.exit(1)
}

console.log('\nUsing Meta connection:', metaConn.id)

// 3. Update all meta ad_accounts to point to this connection
const { data: updated, error } = await supabase
  .from('ad_accounts')
  .update({ connection_id: metaConn.id })
  .eq('provider', 'meta')
  .select('id, name, account_id')

if (error) console.error('Update error:', error)
else console.log('\nUpdated ad_accounts:', updated?.map(a => `${a.name} (${a.account_id})`))
