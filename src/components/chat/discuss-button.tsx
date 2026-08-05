'use client'

/**
 * <DiscussButton> — opens the chat discussion room for a CRM entity.
 * One room per entity (migrations 019/026).
 *
 * mode='panel' (default): opens the room in a slide-over <DiscussPanel> right
 * on the current page — an Odoo-chatter-style side panel, no navigation.
 * mode='navigate': the original behavior, jump to /dashboard/chat.
 *
 * Mount anywhere: requests, tasks, advertising projects, clients, plans.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import { getOrCreateEntityConversation, type DiscussEntityType } from '@/app/(dashboard)/dashboard/chat/actions'
import { DiscussPanel } from './discuss-panel'

export function DiscussButton({ entityType, entityId, label = 'Discuss', variant = 'default', mode = 'panel', panelTitle }: {
  entityType: DiscussEntityType
  entityId: string
  label?: string
  variant?: 'default' | 'icon' | 'menu-item'
  mode?: 'panel' | 'navigate'
  /** Header shown in the panel — e.g. the task title. Falls back to "Discussion". */
  panelTitle?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [panelOpen, setPanelOpen] = useState(false)

  // stopPropagation: these mount inside clickable task/request rows, where a
  // bubbling click would also open the row's own modal behind the panel.
  const open = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (mode === 'panel') { setPanelOpen(true); return }
    startTransition(async () => {
      const res = await getOrCreateEntityConversation(entityType, entityId)
      if (res.ok) router.push(`/dashboard/chat?c=${res.data.id}`)
      else alert(res.error)
    })
  }

  const panel = panelOpen && (
    <DiscussPanel entityType={entityType} entityId={entityId} title={panelTitle} onClose={() => setPanelOpen(false)} />
  )

  if (variant === 'icon') {
    return (
      <>
        <button onClick={open} disabled={pending} title={label} aria-label={label}
          className="rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
          <MessageSquare className="h-4 w-4" />
        </button>
        {panel}
      </>
    )
  }
  if (variant === 'menu-item') {
    return (
      <>
        <button onClick={open} disabled={pending}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
          <MessageSquare className="h-4 w-4 text-muted-foreground" /> {label}
        </button>
        {panel}
      </>
    )
  }
  return (
    <>
      <button onClick={open} disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
        <MessageSquare className="h-3.5 w-3.5" /> {pending ? 'Opening…' : label}
      </button>
      {panel}
    </>
  )
}
