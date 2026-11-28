import { redirect } from 'next/navigation'
import Header from '@/components/layout/header'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { TimelineTab } from '@/components/activity/timeline-tab'

export const dynamic = 'force-dynamic'

/**
 * Global activity feed — everything that happens across the workspace.
 * Gated by timeline.view_all (admins always pass). Design: UI_FLOW.md §1.
 */
export default async function ActivityPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (me && !hasPermission(me, 'timeline.view_all')) redirect('/dashboard')

  return (
    <>
      <Header title="Activity" subtitle="Everything happening across the workspace" />
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6">
        <TimelineTab scope={{ global: true }} />
      </div>
    </>
  )
}
