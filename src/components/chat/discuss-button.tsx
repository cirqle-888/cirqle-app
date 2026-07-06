'use client'

/**
 * <DiscussButton> — opens (or creates) the chat discussion room for a CRM
 * entity and navigates to it. One room per entity (migration 019).
 * Mount anywhere: requests, tasks, advertising projects, clients.
 */

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import { getOrCreateEntityConversation, type DiscussEntityType } from '@/app/(dashboard)/dashboard/chat/actions'

export function DiscussButton({ entityType, entityId, label = 'Discuss', variant = 'default' }: {
  entityType: DiscussEntityType
  entityId: string
  label?: string
  variant?: 'default' | 'icon' | 'menu-item'
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const open = () => {
    startTransition(async () => {
      const res = await getOrCreateEntityConversation(entityType, entityId)
      if (res.ok) router.push(`/dashboard/chat?c=${res.data.id}`)
      else alert(res.error)
    })
  }

  if (variant === 'icon') {
    return (
      <button onClick={open} disabled={pending} title={label} aria-label={label}
        className="rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
        <MessageSquare className="h-4 w-4" />
      </button>
    )
  }
  if (variant === 'menu-item') {
    return (
      <button onClick={open} disabled={pending}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
        <MessageSquare className="h-4 w-4 text-muted-foreground" /> {label}
      </button>
    )
  }
  return (
    <button onClick={open} disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
      <MessageSquare className="h-3.5 w-3.5" /> {pending ? 'Opening…' : label}
    </button>
  )
}
