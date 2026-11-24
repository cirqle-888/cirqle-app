import { redirect } from 'next/navigation'
import { loadCurrentUser } from '@/lib/permissions/check'
import { getChatAccessSettings } from '../../chat/actions-plus'
import ChatAccessClient from './chat-access-client'

export const dynamic = 'force-dynamic'

/**
 * Chat access — the admin decides who may chat with whom, by department and
 * by person. Admins only; the rules are enforced in chat's server actions.
 */
export default async function ChatAccessPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!me.isAdmin) redirect('/dashboard')
  const res = await getChatAccessSettings()
  return <ChatAccessClient settings={res.ok ? res.data : null} error={res.ok ? null : res.error} />
}
