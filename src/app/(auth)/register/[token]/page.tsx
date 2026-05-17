import { createAdminClient } from '@/lib/supabase/admin'
import RegisterClient from './register-client'

export const dynamic = 'force-dynamic'

export default async function RegisterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let supabase: ReturnType<typeof createAdminClient>
  try {
    supabase = createAdminClient()
  } catch {
    return (
      <ErrorScreen
        title="Registration not configured"
        body="The admin needs to add the Supabase service role key to enable registration."
      />
    )
  }

  // Try with designation join; fall back without it if the column doesn't exist yet
  let emp: any = null
  {
    const { data, error } = await supabase
      .from('employees')
      .select('id, cqid, name, email, phone, invite_token, invite_token_expires_at, auth_id, is_archived, designation:designation_id ( id, name )')
      .eq('invite_token', token)
      .maybeSingle()
    if (!error) {
      emp = data
    } else {
      const { data: fallback } = await supabase
        .from('employees')
        .select('id, cqid, name, email, phone, invite_token, invite_token_expires_at, auth_id, is_archived')
        .eq('invite_token', token)
        .maybeSingle()
      emp = fallback
    }
  }

  if (!emp) {
    return (
      <ErrorScreen
        title="Invitation not found"
        body="This invitation link is invalid. Ask your administrator for a new one."
      />
    )
  }

  if (emp.is_archived) {
    return (
      <ErrorScreen
        title="Account archived"
        body="This account has been archived. Contact your administrator."
      />
    )
  }

  if (emp.auth_id) {
    return (
      <ErrorScreen
        title="Already registered"
        body="This account is already set up. Use the sign-in page."
        action={{ href: '/login', label: 'Go to sign in' }}
      />
    )
  }

  if (emp.invite_token_expires_at && new Date(emp.invite_token_expires_at) < new Date()) {
    return (
      <ErrorScreen
        title="Invitation expired"
        body="This invitation link has expired. Ask your administrator to send a fresh one."
      />
    )
  }

  const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation

  return (
    <RegisterClient
      token={token}
      employee={{
        id: emp.id,
        cqid: emp.cqid,
        name: emp.name ?? '',
        email: emp.email ?? '',
        phone: emp.phone ?? '',
        designationName: designation?.name ?? null,
      }}
    />
  )
}

function ErrorScreen({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <div className="inline-flex items-center gap-2 mb-6">
          <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center">
            <span className="text-white font-bold text-lg">C</span>
          </div>
          <span className="text-2xl font-bold gradient-text">Cirqle</span>
        </div>
        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4">
            <span className="text-2xl">⚠️</span>
          </div>
          <h1 className="text-lg font-semibold mb-2">{title}</h1>
          <p className="text-sm text-muted-foreground mb-4">{body}</p>
          {action && (
            <a href={action.href} className="text-sm text-primary hover:underline">
              {action.label} →
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
