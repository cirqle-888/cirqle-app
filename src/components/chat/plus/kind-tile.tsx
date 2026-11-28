'use client'

/**
 * How a chat shows what it is, without colour: people are round (initials),
 * rooms are square (an icon), and a work thread also carries a quiet word
 * ("Task", "Request"…). See lib/chat/kinds.
 */

import {
  Bookmark, Briefcase, CalendarDays, CheckSquare, Hash, Inbox, Layers, Lock, Megaphone, Target, Users,
} from 'lucide-react'
import { EmployeePresenceDot } from '@/components/ui/presence-dot'
import { KIND_META, type ChatKind } from '@/lib/chat/kinds'

const ICON: Record<ChatKind, typeof Hash> = {
  direct: Hash, notes: Bookmark, group: Users, channel: Hash, announcement: Megaphone,
  department: Layers, client: Briefcase, task: CheckSquare, request: Inbox, plan: CalendarDays, campaign: Target,
}

const SIZE = {
  sm: { box: 'h-7 w-7 text-[10px]', icon: 'h-3.5 w-3.5', radius: 'rounded-lg' },
  md: { box: 'h-10 w-10 text-xs', icon: 'h-[18px] w-[18px]', radius: 'rounded-xl' },
} as const

export function KindTile({ kind, name, isPrivate = false, partnerId = null, size = 'md' }: {
  kind: ChatKind
  /** Shown as initials for a person. */
  name: string
  isPrivate?: boolean
  /** The other person in a direct chat, for their status dot. */
  partnerId?: string | null
  size?: keyof typeof SIZE
}) {
  const s = SIZE[size]
  if (KIND_META[kind].shape === 'round') {
    const letters = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
      || name.slice(0, 2).toUpperCase()
    return (
      <span className={`relative flex shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] font-semibold text-foreground/80 ${s.box}`}>
        {/^CQID\d+$/i.test(name) ? name.slice(-2) : letters}
        {partnerId && <EmployeePresenceDot employeeId={partnerId} size={size === 'sm' ? 'xs' : 'sm'} className="absolute -bottom-0.5 -right-0.5" />}
      </span>
    )
  }
  const Icon = kind === 'channel' && isPrivate ? Lock : ICON[kind]
  const thread = KIND_META[kind].thread
  return (
    <span className={`flex shrink-0 items-center justify-center border text-muted-foreground ${s.box} ${s.radius} ${
      thread ? 'border-dashed border-border bg-transparent' : 'border-border/70 bg-muted/60'}`}>
      <Icon className={s.icon} strokeWidth={1.75} />
    </span>
  )
}

/** A quiet label for a work thread or a room, e.g. TASK · CLIENT. */
export function KindTag({ kind }: { kind: ChatKind }) {
  return (
    <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wider text-muted-foreground">
      {KIND_META[kind].label}
    </span>
  )
}
