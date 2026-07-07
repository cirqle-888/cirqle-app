'use client'

/**
 * Active-workspace context — server-preloaded (dashboard layout) so the
 * sidebar filters correctly on first paint, no flicker. Switching calls the
 * server action (validates membership) then updates local state + navigates
 * to the workspace's default landing page.
 */
import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { switchWorkspace, type Workspace } from '@/lib/workspaces/actions'

interface WorkspaceContextValue {
  current: Workspace
  available: Workspace[]
  canManage: boolean
  /** Pass null to switch to "All Workspace". */
  switchTo: (workspaceId: string | null) => Promise<void>
  switching: boolean
}

const Ctx = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ initial, children }: {
  initial: { current: Workspace; available: Workspace[]; canManage: boolean }
  children: ReactNode
}) {
  const [current, setCurrent] = useState<Workspace>(initial.current)
  const [switching, setSwitching] = useState(false)
  const router = useRouter()

  const switchTo = useCallback(async (workspaceId: string | null) => {
    const target = workspaceId
      ? initial.available.find(w => w.id === workspaceId)
      : initial.available.find(w => w.isSystem)
    if (!target || target.id === current.id) return
    setSwitching(true)
    setCurrent(target) // optimistic — nav filter updates immediately
    const res = await switchWorkspace(workspaceId)
    setSwitching(false)
    if (res.ok) router.push(res.data.landingHref)
    // On failure, leave the optimistic switch in place for this session —
    // next full load will resync from the server-persisted value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, initial.available])

  const value = useMemo<WorkspaceContextValue>(
    () => ({ current, available: initial.available, canManage: initial.canManage, switchTo, switching }),
    [current, initial.available, initial.canManage, switchTo, switching],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return ctx
}
