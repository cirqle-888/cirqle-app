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
export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>('super_admin')
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchRole() {
      try {
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          // Not logged in — default to super_admin (auth guard handles redirect)
          setRole('super_admin')
          setLoading(false)
          return
        }

        const { data: emp, error } = await supabase
          .from('employees')
          .select('id, auth_id, name, email, role, cqid, is_active, avatar_url')
          .or(`auth_id.eq.${user.id},email.eq.${user.email}`)
          .maybeSingle()

        if (error || !emp) {
          // No employee record → assume super_admin (e.g. Farooq)
          setRole('super_admin')
          setEmployee(null)
        } else {
          setRole((emp.role as Role) || 'super_admin')
          setEmployee(emp as Employee)
        }
      } catch {
        setRole('super_admin')
      } finally {
        setLoading(false)
      }
    }

    fetchRole()
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
