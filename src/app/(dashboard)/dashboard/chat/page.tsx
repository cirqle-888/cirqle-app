import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { ChatClient } from './chat-client'
import { listConversations } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Team chat — Cirqle Connect Phase 1.
 * Gate: chat.access (admins always pass). Live updates come from the browser's
 * direct Supabase Realtime subscription (RLS-authorized, migration 015).
 */
export default async function ChatPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!hasPermission(me, 'chat.access')) redirect('/dashboard')

  // Load the chat list with the page. It used to be fetched by the browser only
  // after the page had arrived and started up — a second trip to the server
  // before anything could be shown. A failure here is not fatal: the client
  // loads the list itself, as before.
  const initial = await listConversations().catch(() => null)

  return (
    <ChatClient
      initialConversations={initial?.ok ? initial.data : null}
      me={{ employeeId: me.employeeId, name: me.name, cqid: me.cqid }}
      canCreateChannels={me.isAdmin || me.permissions.has('chat.create_channels')}
      isAdmin={me.isAdmin}
    />
  )
}
