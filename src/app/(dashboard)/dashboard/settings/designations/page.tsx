import { createClient } from '@/lib/supabase/server'
import DesignationsClient from './designations-client'

export const dynamic = 'force-dynamic'

export default async function DesignationsPage() {
  const supabase = await createClient()

  const [designationsRes, permissionsRes, assignmentsRes, employeesRes] = await Promise.all([
    supabase
      .from('designations')
      .select('id, name, description, is_admin, is_system, display_order')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true }),
    supabase
      .from('permissions')
      .select('id, module, action, key, label, description, display_order')
      .order('display_order', { ascending: true }),
    supabase
      .from('designation_permissions')
      .select('designation_id, permission_id, allowed'),
    supabase
      .from('employees')
      .select('designation_id')
      .eq('is_archived', false),
  ])

  // Tally member counts client-side (avoids needing a SQL view).
  const memberCounts: Record<string, number> = {}
  for (const row of employeesRes.data ?? []) {
    const did = (row as any).designation_id as string | null
    if (!did) continue
    memberCounts[did] = (memberCounts[did] ?? 0) + 1
  }

  return (
    <DesignationsClient
      designations={designationsRes.data ?? []}
      permissions={permissionsRes.data ?? []}
      assignments={assignmentsRes.data ?? []}
      memberCounts={memberCounts}
    />
  )
}
