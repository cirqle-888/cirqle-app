'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PermKey } from '@/lib/permissions/keys'
// TEMPORARY — remove with the bypass. See src/lib/permissions/dev-bypass.ts
import { isDevPermissionBypassActive } from '@/lib/permissions/dev-bypass'

export interface PermissionUser {
  employeeId: string
  authId: string
  cqid: string
  name: string
  email: string
  designationId: string | null
  designationName: string | null
  isAdmin: boolean
  permissions: string[]
  dateOfBirth: string | null
  /** True while an admin is browsing as this employee (read-only preview). */
  isViewAs?: boolean
}

interface PermissionContextValue {
  user: PermissionUser
  can: (key: PermKey | string) => boolean
  /** Admin-only: temporary session toggle to reveal real names instead of CQID. Defaults to OFF on every page load. */
  revealNames: boolean
  setRevealNames: (v: boolean) => void
  /** Workspace-level logo for light mode (from company_settings.logo_url). null = no logo configured; render the default brand mark. */
  logoUrl: string | null
  /** Workspace-level logo for dark mode (from company_settings.logo_url_dark).
   *  Falls back to logoUrl when not set so light-only workspaces still work in dark mode. */
  logoUrlDark: string | null
  /** Workspace icon / favicon (from company_settings.favicon_url) — used for the
   *  collapsed sidebar rail where the full wordmark logo doesn't fit. null = none. */
  faviconUrl: string | null
}

const Ctx = createContext<PermissionContextValue | null>(null)

export function PermissionProvider(
  { user, logoUrl = null, logoUrlDark = null, faviconUrl = null, children }: {
    user: PermissionUser
    logoUrl?: string | null
    logoUrlDark?: string | null
    faviconUrl?: string | null
    children: ReactNode
  },
) {
  const [revealNames, setRevealNames] = useState(false)
  const perms = useMemo(() => new Set(user.permissions), [user.permissions])

  // Stable value reference — without useMemo every consumer re-renders on every Provider tick.
  const value = useMemo<PermissionContextValue>(() => ({
    user,
    // TEMPORARY dev bypass (dead code in production builds) — see
    // src/lib/permissions/dev-bypass.ts. Keeps the client's `can()` in step
    // with the server guards so the UI doesn't hide what the server allows.
    //
    // Skipped while previewing another account, mirroring hasPermission on the
    // server. Without this the sidebar showed every page during a preview in
    // development — including Requests, which the previewed designer cannot
    // open — making the preview confidently wrong about the one thing it is for.
    can: (key) =>
      user.isAdmin || (!user.isViewAs && isDevPermissionBypassActive())
        ? true
        : perms.has(key),
    revealNames: user.isAdmin && revealNames,
    setRevealNames,
    logoUrl,
    // Dark logo falls back to light logo so workspaces with one logo still look right in both modes.
    logoUrlDark: logoUrlDark || logoUrl,
    faviconUrl,
  }), [user, perms, revealNames, logoUrl, logoUrlDark, faviconUrl])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePermissions(): PermissionContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used inside <PermissionProvider>')
  return ctx
}
