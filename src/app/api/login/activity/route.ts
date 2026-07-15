import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity/log'

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return new NextResponse(null, { status: 401 })
    
    const admin = createAdminClient()
    const { data: emp } = await admin
      .from('employees').select('id').eq('auth_id', user.id).maybeSingle()
    
    if (!emp?.id) return new NextResponse(null, { status: 404 })
    
    void logActivity({
      actorId: emp.id, subjectId: emp.id,
      entityType: 'auth', entityId: emp.id, action: 'login',
    })
    
    return new NextResponse(null, { status: 200 })
  } catch {
    return new NextResponse(null, { status: 500 })
  }
}
