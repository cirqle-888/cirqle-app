import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadPostQueue } from '@/lib/social-hub/post-queue-load'
import { committedTarget } from '@/lib/social-hub/post-queue'
import { toISODate } from '@/lib/utils/local-date'
import PostQueueClient from './post-queue-client'

export const dynamic = 'force-dynamic'

/**
 * Posting queue — the social manager's own page.
 *
 * Gated on social.publish. Someone who only plans the calendar (social.manage)
 * does not land here, and a designer never does: this is the step AFTER the
 * artwork exists.
 */
export default async function SocialQueuePage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.SOCIAL_PUBLISH)) redirect('/dashboard')

  const admin = createAdminClient()
  const today = toISODate(new Date())
  const rows = await loadPostQueue(admin, today)

  // Committed volume per client, counted ONLY for services this client's own
  // calendar actually plans. Elara holds two active packages — 15 social
  // posters and 2 logos — and only the posters belong in a posting target.
  const plannedServices = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.serviceId) continue
    const set = plannedServices.get(r.clientId) ?? new Set<string>()
    set.add(r.serviceId)
    plannedServices.set(r.clientId, set)
  }

  const targets: Record<string, number> = {}
  const { data: pkgs, error: pkgErr } = await admin
    .from('client_packages')
    .select('client_id, items:client_package_items(service_id, included_quantity)')
    .eq('status', 'active')
    .is('deleted_at', null)

  // Not swallowed: a silent catch here previously hid a wrong column name and
  // reported every client as having no package at all.
  if (pkgErr) {
    console.error('[social/queue] package targets unavailable:', pkgErr.message)
  } else {
    type PkgRow = { client_id: string; items?: { service_id: string; included_quantity: number | null }[] }
    for (const p of (pkgs ?? []) as unknown as PkgRow[]) {
      const onCalendar = plannedServices.get(p.client_id)
      if (!onCalendar) continue
      const t = committedTarget(
        (p.items ?? []).map(i => ({ serviceId: i.service_id, quantity: i.included_quantity ?? 0 })),
        onCalendar,
      )
      if (t !== null) targets[p.client_id] = (targets[p.client_id] ?? 0) + t
    }
  }

  return (
    <PostQueueClient
      initialRows={rows}
      targets={targets}
      canPublishApi={hasPermission(me, PERMS.SOCIAL_APPROVE)}
    />
  )
}
