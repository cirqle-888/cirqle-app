'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────
export type Role = 'super_admin' | 'accounts' | 'team_lead' | 'employee' | 'view_only'

export interface Employee {
  id: string
  auth_id: string | null
  name: string | null
  email: string | null
  role: Role
  cqid: string | null
  is_active: boolean
  avatar_url?: string | null
}

/** Shape passed from the Server Component layout to pre-populate role context. */
export interface ServerEmployee {
  id: string
  authId: string
  name: string
  email: string
  cqid: string
  isAdmin: boolean
}

interface RoleContextType {
  role: Role
  employee: Employee | null
  loading: boolean
}

// ─────────────────────────────────────────────────────
// Route access map
// ─────────────────────────────────────────────────────
export const roleRoutes: Record<Role, string[]> = {
  super_admin: [
    '/dashboard',
    '/dashboard/tasks',
    '/dashboard/contributions',
    '/dashboard/invoices',
    '/dashboard/quotations',
    '/dashboard/cashbook',
    '/dashboard/payroll',
    '/dashboard/reports',
    '/dashboard/import',
    '/dashboard/settings',
  ],
  accounts: [
    '/dashboard',
    '/dashboard/invoices',
    '/dashboard/quotations',
    '/dashboard/cashbook',
    '/dashboard/payroll',
    '/dashboard/reports',
    '/dashboard/settings',
  ],
  team_lead: [
    '/dashboard',
    '/dashboard/tasks',
    '/dashboard/contributions',
    '/dashboard/reports',
  ],
  employee: [
    '/dashboard',
    '/dashboard/tasks',
    '/dashboard/contributions',
  ],
  view_only: [
    '/dashboard',
    '/dashboard/reports',
  ],
}

// ─────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────
const RoleContext = createContext<RoleContextType>({
  role: 'super_admin',
  employee: null,
  loading: true,
})

export function useRole() {
  return useContext(RoleContext)
}

// ─────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────

interface RoleProviderProps {
  children: ReactNode
  /**
   * When provided (from a Server Component layout), the role is
   * pre-populated on first render — eliminating the async-fetch flash.
   * Without this, the provider falls back to an async client fetch.
   */
  initialEmployee?: ServerEmployee | null
}

function serverToEmployee(s: ServerEmployee): Employee {
  return {
    id: s.id,
    auth_id: s.authId,
    name: s.name,
    email: s.email,
    role: s.isAdmin ? 'super_admin' : 'employee',
    cqid: s.cqid,
    is_active: true,
  }
}

export function RoleProvider({ children, initialEmployee }: RoleProviderProps) {
  // If pre-loaded from server, initialise synchronously — no flash.
  const preloaded = initialEmployee !== undefined
  const initRole: Role = initialEmployee
    ? (initialEmployee.isAdmin ? 'super_admin' : 'employee')
    : 'employee'
  const initEmp: Employee | null = initialEmployee ? serverToEmployee(initialEmployee) : null

  const [role, setRole] = useState<Role>(initRole)
  const [employee, setEmployee] = useState<Employee | null>(initEmp)
  const [loading, setLoading] = useState(!preloaded)

  useEffect(() => {
    // Skip async fetch when server already provided the data
    if (preloaded) return

    async function fetchRole() {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          setRole('employee')
          setLoading(false)
          return
        }

        const { data: emp, error } = await supabase
          .from('employees')
          .select('id, auth_id, name, email, role, cqid, is_active, avatar_url')
          .or(`auth_id.eq.${user.id},email.eq.${user.email}`)
          .maybeSingle()

        if (error || !emp) {
          setRole('employee')
          setEmployee(null)
        } else {
          setRole((emp.role as Role) || 'employee')
          setEmployee(emp as Employee)
        }
      } catch {
        setRole('employee')
      } finally {
        setLoading(false)
      }
    }

    fetchRole()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <span className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <RoleContext.Provider value={{ role, employee, loading }}>
      {children}
    </RoleContext.Provider>
  )
}
