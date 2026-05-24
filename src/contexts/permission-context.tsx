'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PermKey } from '@/lib/permissions/keys'

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
}

interface PermissionContextValue {
  user: PermissionUser
  can: (key: PermKey | string) => boolean
  /** Admin-only: temporary session toggle to reveal real names instead of CQID. Defaults to OFF on every page load. */
  revealNames: boolean
  setRevealNames: (v: boolean) => void
}

const Ctx = createContext<PermissionContextValue | null>(null)

export function PermissionProvider({ user, children }: { user: PermissionUser; children: ReactNode }) {
  const [revealNames, setRevealNames] = useState(false)
  const perms = useMemo(() => new Set(user.permissions), [user.permissions])

  // Stable value reference — without useMemo every consumer re-renders on every Provider tick.
  const value = useMemo<PermissionContextValue>(() => ({
    user,
    can: (key) => (user.isAdmin ? true : perms.has(key)),
    revealNames: user.isAdmin && revealNames,
    setRevealNames,
  }), [user, perms, revealNames])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePermissions(): PermissionContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePermissions must be used inside <PermissionProvider>')
  return ctx
}
