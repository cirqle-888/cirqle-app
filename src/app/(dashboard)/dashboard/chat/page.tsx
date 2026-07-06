import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { ChatClient } from './chat-client'

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

  return (
    <ChatClient
      me={{ employeeId: me.employeeId, name: me.name, cqid: me.cqid }}
      canCreateChannels={me.isAdmin || me.permissions.has('chat.create_channels')}
    />
  )
}
