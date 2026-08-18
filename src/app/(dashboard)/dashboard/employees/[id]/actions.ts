'use server'

import { createTypedAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { revalidatePath } from 'next/cache'

export async function saveCommissionAgreement(payload: any, editingId?: string | null) {
  const user = await loadCurrentUser()
  if (!hasPermission(user, 'employees.manage_agreements')) {
    throw new Error('Unauthorized to manage agreements')
  }

  const supabase = createTypedAdminClient()

  if (editingId) {
    const { error } = await supabase
      .from('employee_commission_agreements')
      .update(payload)
      .eq('id', editingId)

    if (error) throw new Error(error.message)
    revalidatePath(`/dashboard/employees/${payload.employee_id}`)
    return { success: true }
  } else {
    const { data, error } = await supabase
      .from('employee_commission_agreements')
      .insert(payload)
      .select()
      .single()

    if (error) throw new Error(error.message)
    revalidatePath(`/dashboard/employees/${payload.employee_id}`)
    return { success: true, data }
  }
}
