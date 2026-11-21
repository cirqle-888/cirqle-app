'use server'

import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { checkAuthorize, issueCode, type AuthorizeRequest } from '@/lib/mcp/oauth'
import { logActivity } from '@/lib/activity/log'

const FIELDS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'response_type', 'state', 'scope'] as const

function readForm(form: FormData): Partial<AuthorizeRequest> {
  return Object.fromEntries(FIELDS.map(k => [k, String(form.get(k) ?? '')])) as Partial<AuthorizeRequest>
}

function back(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
  return u.toString()
}

/** Allow: a signed-in Cirqle admin approves the AI app; it gets a 5-minute code. */
export async function approveConnection(form: FormData) {
  const p = readForm(form)
  const me = await loadCurrentUser().catch(() => null)
  const now = Math.floor(Date.now() / 1000)
  const check = checkAuthorize(p, now)
  if (!check.ok) {
    if (check.redirectOk && p.redirect_uri) redirect(back(p.redirect_uri, { error: check.error, error_description: check.description, state: p.state }))
    redirect('/oauth/authorize?error=invalid')
  }
  if (!me?.isAdmin || !me.employeeId) redirect(back(p.redirect_uri!, { error: 'access_denied', error_description: 'Only Cirqle admins can connect AI apps.', state: p.state }))
  const code = issueCode({ clientId: p.client_id!, redirectUri: p.redirect_uri!, challenge: p.code_challenge!, sub: me.employeeId }, now)
  if (!code) redirect(back(p.redirect_uri!, { error: 'server_error', state: p.state }))
  void logActivity({
    actorId: me.employeeId, entityType: 'auth', entityId: me.employeeId, action: 'ai_app_connected',
    detail: { label: `Connected an AI app to Cirqle: ${check.client.n}`, redirect: new URL(p.redirect_uri!).host },
  })
  redirect(back(p.redirect_uri!, { code, state: p.state }))
}

/** Cancel: tell the AI app the person said no. */
export async function denyConnection(form: FormData) {
  const p = readForm(form)
  const check = checkAuthorize(p, Math.floor(Date.now() / 1000))
  if (!check.ok && !check.redirectOk) redirect('/dashboard')
  redirect(back(p.redirect_uri!, { error: 'access_denied', state: p.state }))
}
