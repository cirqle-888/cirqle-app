import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import InboxClient from './inbox-client'

export const dynamic = 'force-dynamic'

/**
 * Comment inbox — every unanswered comment across both platforms, in one queue.
 *
 * The accounts are listed server-side; the comments themselves are fetched from
 * Meta on demand, per account. Loading nine accounts' comments up front would
 * mean nine Graph calls before the page paints, for a screen where someone
 * works one account at a time.
 */
export default async function SocialInboxPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.SOCIAL_PUBLISH)) redirect('/dashboard')

  const admin = createAdminClient()
  const { data } = await admin
    .from('social_accounts')
    .select('id, platform, name, username, profile_picture_url, client_id, owner_type, status')
    .neq('status', 'disconnected')
    .order('platform')

  const { data: clients } = await admin.from('clients').select('id, name')
  const clientName = new Map(((clients ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]))

  const accounts = ((data ?? []) as {
    id: string; platform: string; name: string; username: string | null
    profile_picture_url: string | null; client_id: string | null; owner_type: string | null
  }[]).map(a => ({
    id: a.id,
    platform: a.platform as 'instagram' | 'facebook_page',
    label: a.username || a.name,
    avatar: a.profile_picture_url,
    owner: a.client_id ? (clientName.get(a.client_id) ?? 'Client') : 'Cirqle',
  }))

  return (
    <InboxClient
      accounts={accounts}
      canDelete={hasPermission(me, PERMS.SOCIAL_APPROVE)}
    />
  )
}
