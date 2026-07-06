import { redirect } from 'next/navigation'
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
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything happening across the workspace — tasks, billing, clients, campaigns and more.
        </p>
      </div>
      <TimelineTab scope={{ global: true }} />
    </div>
  )
}
