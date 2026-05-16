import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase admin credentials. Add SUPABASE_SERVICE_ROLE_KEY to .env.local')
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}
