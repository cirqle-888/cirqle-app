import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import CalendarClient from './calendar-client'

export const dynamic = 'force-dynamic'

/**
 * Publishing calendar — the scheduled/published social_posts for a month, with
 * the composer. Distinct from the older /dashboard/social-calendar planner
 * (which feeds the Requests inbox); this one publishes to Meta.
 */
export default async function SocialCalendarPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const canView = !me || hasPermission(me, [PERMS.SOCIAL_VIEW_INSIGHTS, PERMS.SOCIAL_PUBLISH])
  if (me && !canView) redirect('/dashboard')
  const canPublish = !me || hasPermission(me, PERMS.SOCIAL_PUBLISH)
  const canApprove = !me || hasPermission(me, PERMS.SOCIAL_APPROVE)

  const sp = searchParams ? await searchParams : undefined
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''
  const monthParam = first(sp?.month) // YYYY-MM
  const clientParam = first(sp?.client)

  const now = new Date()
  const [year, month] = monthParam && /^\d{4}-\d{2}$/.test(monthParam)
    ? monthParam.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1]

  const monthStart = new Date(Date.UTC(year, month - 1, 1))
  const monthEnd = new Date(Date.UTC(year, month, 1))

  const admin = createAdminClient()

  const [postsRes, clientsRes, accountsRes, employeesRes] = await Promise.all([
    (() => {
      let q = admin
        .from('social_posts')
        .select(`
          id, client_id, account_id, content_type, status, caption, hashtags,
          first_comment, link_url, media, cover_url, share_to_feed, scheduled_at,
          published_at, permalink, publish_error, external_media_id, designer_id, assigned_to, created_at,
          account:social_accounts(name, username, platform, profile_picture_url)
        `)
        .is('deleted_at', null)
        // Show scheduled/published in the month plus any drafts (drafts have no date)
        .or(`and(scheduled_at.gte.${monthStart.toISOString()},scheduled_at.lt.${monthEnd.toISOString()}),and(published_at.gte.${monthStart.toISOString()},published_at.lt.${monthEnd.toISOString()}),status.in.(draft,awaiting_approval,approved)`)
        .order('scheduled_at', { ascending: true })
        .limit(1000)
      if (clientParam) q = q.eq('client_id', clientParam)
      return q
    })(),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
    admin
      .from('social_accounts')
      .select('id, client_id, owner_type, platform, name, username, profile_picture_url, status, publishing_enabled')
      .neq('status', 'disconnected')
      .order('name'),
    admin.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
  ])

  const posts = (postsRes.data ?? []).map((p: any) => {
    const account = Array.isArray(p.account) ? p.account[0] : p.account
    return {
      id: p.id, client_id: p.client_id, account_id: p.account_id,
      content_type: p.content_type, status: p.status,
      caption: p.caption, hashtags: p.hashtags, first_comment: p.first_comment,
      link_url: p.link_url, media: p.media ?? [], cover_url: p.cover_url,
      share_to_feed: p.share_to_feed, scheduled_at: p.scheduled_at, published_at: p.published_at,
      permalink: p.permalink, publish_error: p.publish_error,
      external_media_id: p.external_media_id ?? null,
      designer_id: p.designer_id, assigned_to: p.assigned_to,
      account_name: account?.name ?? '—', account_username: account?.username ?? null,
      account_platform: account?.platform ?? 'facebook_page',
    }
  })

  // Only clients you can ACTUALLY post for. 31 active clients were listed while
  // just 4 have a connected account, so 27 of them were dead ends: pick one and
  // the account dropdown is empty with nothing to explain why. Cirqle's own
  // accounts are handled separately in the composer — they have no client by
  // design, so no entry here could ever reach them.
  const accountsForPosting = (accountsRes.data ?? []) as {
    client_id: string | null; publishing_enabled: boolean
  }[]
  const clientsWithAccounts = new Set(
    accountsForPosting.filter(a => a.publishing_enabled && a.client_id).map(a => a.client_id as string),
  )
  const postableClients = ((clientsRes.data ?? []) as { id: string; name: string }[])
    .filter(c => clientsWithAccounts.has(c.id))

  return (
    <CalendarClient
      posts={posts}
      clients={postableClients}
      accounts={(accountsRes.data ?? []) as never[]}
      employees={(employeesRes.data ?? []) as never[]}
      year={year}
      month={month}
      clientFilter={clientParam}
      canPublish={canPublish}
      canApprove={canApprove}
    />
  )
}
