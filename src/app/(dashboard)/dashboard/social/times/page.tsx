import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { columnExists } from '@/lib/supabase/server'
import PostingTimesClient from './posting-times-client'

export const dynamic = 'force-dynamic'

/**
 * Posting times — slots, evidence and the bulk planner on one screen.
 *
 * Three jobs that look separate and are not: you read a client's analytics,
 * you write down the times that follow from it, and then you put a month of
 * posters into those times. Splitting them across three pages would mean
 * holding the first in your head while doing the third.
 *
 * Gated on social.view so a planner can see the times; the controls that
 * change anything re-check social.manage / social.publish server-side.
 */
export default async function PostingTimesPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.SOCIAL_VIEW)) redirect('/dashboard')

  const admin = createAdminClient()

  // The clients we actually post for. has_social_media_service is the explicit
  // flag the posting queue already uses; falling back to "has a calendar"
  // keeps the page useful before anyone has set that flag.
  const hasGate = await columnExists(admin, 'clients', 'has_social_media_service')
  let clients: Array<{ id: string; name: string }> = []

  if (hasGate) {
    const { data } = await admin
      .from('clients')
      .select('id, name')
      .eq('has_social_media_service', true)
      .is('deleted_at', null)
      .order('name')
    clients = (data ?? []).map(c => ({ id: String(c.id), name: String(c.name ?? 'Client') }))
  }

  if (!clients.length) {
    const { data } = await admin
      .from('social_calendars')
      .select('client:client_id(id, name)')
      .limit(200)
    const seen = new Map<string, string>()
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const c = Array.isArray(row.client) ? row.client[0] : row.client
      const client = c as { id?: string; name?: string } | undefined
      if (client?.id) seen.set(String(client.id), String(client.name ?? 'Client'))
    }
    clients = [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const ready = await columnExists(admin, 'social_calendar_items', 'scheduled_time')

  return (
    <PostingTimesClient
      clients={clients}
      ready={ready}
      canManage={hasPermission(me, PERMS.SOCIAL_MANAGE)}
      canPublish={hasPermission(me, PERMS.SOCIAL_PUBLISH)}
    />
  )
}
