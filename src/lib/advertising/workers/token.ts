import { DequeuedJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/advertising/providers'
import { decryptToken, encryptToken } from '@/lib/integrations/tokens'
import { redactTokens } from '@/lib/integrations/meta/client'

export async function refreshTokenWorker(job: DequeuedJob): Promise<any> {
  const { connection_id } = job.payload
  if (!connection_id) throw new Error('Missing connection_id in job payload')

  const admin = createAdminClient()

  const { data: conn, error: connErr } = await admin
    .from('provider_connections')
    .select('*')
    .eq('id', connection_id)
    .single()

  if (connErr || !conn) {
    throw new Error(`Connection ${connection_id} not found.`)
  }

  const provider = getProvider(conn.provider)
  if (!provider.refreshToken) {
    throw new Error(`Provider ${conn.provider} does not support token refreshing.`)
  }

  // Tokens are stored encrypted (AES-256-GCM); legacy plaintext rows pass through.
  const currentToken = decryptToken(conn.refresh_token || conn.access_token)
  if (!currentToken) throw new Error('Connection has no stored token to refresh.')

  let refreshed
  try {
    refreshed = await provider.refreshToken(currentToken)
  } catch (err: any) {
    // A dead token cannot be re-exchanged — surface it on the connection so the
    // integrations UI shows "needs reauthorization" instead of failing silently.
    await admin
      .from('provider_connections')
      .update({ status: 'expired', last_error: redactTokens(err?.message ?? 'Token refresh failed') })
      .eq('id', connection_id)
      .then(null, () => {})
    throw err
  }

  if (!refreshed.access_token) {
    throw new Error(`Provider ${conn.provider} failed to return a new access token.`)
  }

  const { error: updateErr } = await admin
    .from('provider_connections')
    .update({
      access_token: encryptToken(refreshed.access_token),
      refresh_token: refreshed.refresh_token ? encryptToken(refreshed.refresh_token) : conn.refresh_token,
      token_expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : conn.token_expires_at,
      status: 'active',
      last_error: null,
    })
    .eq('id', connection_id)

  if (updateErr) throw updateErr

  return { 
    refreshed: true, 
    expires_in: refreshed.expires_in,
    provider: conn.provider
  }
}
