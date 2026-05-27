import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import type { PermKey } from './keys'

export interface CurrentUser {
  authId: string
  employeeId: string
  cqid: string
  name: string
  email: string
  designationId: string | null
  designationName: string | null
  isAdmin: boolean
  isArchived: boolean
  permissions: Set<string>
  dateOfBirth: string | null
}

/**
 * Load the currently-authenticated user with their effective permission set.
 * Returns null when not signed in. Gracefully degrades to admin-like access when the
 * designations migration has not yet been applied (so the app keeps working pre-migration).
 *
 * Wrapped with React `cache()` so multiple server components calling this within
 * the same request share a single DB round-trip instead of each running their own.
 */
export const loadCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Try the new shape first (with designation_id + new columns)
  let emp: any = null
  try {
    const { data } = await supabase
      .from('employees')
      .select(`
        id, cqid, name, email, is_archived, date_of_birth,
        designation:designation_id ( id, name, is_admin )
      `)
      .eq('auth_id', user.id)
      .maybeSingle()
    emp = data
  } catch {
    // Migration not yet applied
  }

  // Fallback: old shape (no designation_id, no is_archived, no date_of_birth)
  if (!emp) {
    const { data } = await supabase
      .from('employees')
      .select('id, cqid, name, email, role')
      .eq('auth_id', user.id)
      .maybeSingle()
    if (!data) return null
    return {
      authId: user.id,
      employeeId: data.id,
      cqid: data.cqid ?? '',
      name: data.name ?? '',
      email: data.email ?? '',
      designationId: null,
      designationName: null,
      isAdmin: data.role === 'super_admin',
      isArchived: false,
      permissions: new Set(),
      dateOfBirth: null,
    }
  }

  const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation
  const isAdmin = designation?.is_admin === true

  let permissions = new Set<string>()
  if (isAdmin) {
    try {
      const { data: all } = await supabase.from('permissions').select('key')
      permissions = new Set((all ?? []).map((p: any) => p.key))
    } catch {
      // permissions table missing — admin-by-flag still works via isAdmin=true
    }
  } else if (designation?.id) {
    try {
      const { data: dp } = await supabase
        .from('designation_permissions')
        .select('allowed, permission:permission_id(key)')
        .eq('designation_id', designation.id)
        .eq('allowed', true)
      permissions = new Set(
        (dp ?? [])
          .map((r: any) => Array.isArray(r.permission) ? r.permission[0]?.key : r.permission?.key)
          .filter(Boolean)
      )
    } catch {
      // designation_permissions missing — no perms
    }
  }

  return {
    authId: user.id,
    employeeId: emp.id,
    cqid: emp.cqid ?? '',
    name: emp.name ?? '',
    email: emp.email ?? '',
    designationId: designation?.id ?? null,
    designationName: designation?.name ?? null,
    isAdmin,
    isArchived: emp.is_archived === true,
    permissions,
    dateOfBirth: emp.date_of_birth ?? null,
  }
})

export function hasPermission(user: CurrentUser | null, key: PermKey | string): boolean {
  if (!user) return false
  if (user.isArchived) return false
  if (user.isAdmin) return true
  return user.permissions.has(key)
}
