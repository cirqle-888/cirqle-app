'use client'

/**
 * The status dot, and the two wrappers that put it somewhere.
 *
 *   PresenceDot     the dot on its own — for a row that already has an avatar
 *                   or an icon of its own.
 *   PresenceAvatar  EmployeeAvatar with the dot notched into its corner.
 *   PresenceNote    the "🌴 On leave" chip, shown next to a name.
 *
 * Shapes follow the convention people already read fluently from Teams and
 * Slack: filled = here, hollow = not, a bar through it = do not disturb. Colour
 * is never the only signal — colour-blind viewers get the fill/hollow/bar
 * distinction, and every dot carries a title for screen readers.
 */

import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { usePresence } from '@/contexts/presence-context'
import {
  STATUS_META, presenceTitle,
  type EffectivePresence, type PresenceStatus,
} from '@/lib/presence/status'

type DotSize = 'xs' | 'sm' | 'md' | 'lg'

const DOT_PX: Record<DotSize, number> = { xs: 7, sm: 9, md: 11, lg: 14 }

export function PresenceDot({
  status, size = 'sm', title, className = '', ring = true,
}: {
  status: PresenceStatus
  size?: DotSize
  /** Tooltip text. Pass '' to suppress it (when the parent already has one). */
  title?: string
  className?: string
  /** Draw the background-coloured halo that separates the dot from an avatar.
   *  Off for dots sitting on their own in a text row. */
  ring?: boolean
}) {
  const meta = STATUS_META[status]
  const px = DOT_PX[size]
  const label = title ?? meta.label

  return (
    <span
      role="img"
      aria-label={label || meta.label}
      title={label || undefined}
      // cn(), not a template string: callers overlay this on an avatar with
      // `absolute`, and both `relative` and `absolute` in one class attribute
      // is a coin flip decided by Tailwind's source order — which `relative`
      // wins, so the dot rendered BESIDE the avatar instead of on it.
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full border-2',
        meta.dot, meta.ring,
        ring && 'ring-2 ring-background',
        className,
      )}
      style={{ width: px, height: px }}
    >
      {/* Do-not-disturb: the white bar. Drawn as a child rather than a border
          trick so it scales with the dot at every size. */}
      {meta.glyph === 'bar' && (
        <span
          aria-hidden
          className="block rounded-full bg-white"
          style={{ width: Math.max(3, px * 0.55), height: Math.max(1, Math.round(px * 0.18)) }}
        />
      )}
      {/* Be-right-back: a notch out of the top-left, echoing the Teams clock
          without trying to draw a clock at 9 pixels. */}
      {meta.glyph === 'notch' && (
        <span
          aria-hidden
          className="absolute rounded-full bg-background"
          style={{
            width: Math.max(2, px * 0.34), height: Math.max(2, px * 0.34),
            top: -1, left: -1,
          }}
        />
      )}
    </span>
  )
}

/**
 * The live dot for one employee — the component almost every surface wants.
 *
 * Renders NOTHING when presence isn't available (before the migration is
 * applied, or outside the dashboard), so a screen that adopts it looks exactly
 * as it did before rather than declaring the whole org offline. Callers pass
 * an id and nothing else; where the dot goes is theirs to position.
 */
export function EmployeePresenceDot({
  employeeId, size = 'sm', className = '',
}: {
  employeeId: string | null | undefined
  size?: DotSize
  className?: string
}) {
  const { presenceOf, available } = usePresence()
  if (!available || !employeeId) return null
  const p = presenceOf(employeeId)
  return <PresenceDot status={p.status} size={size} title={presenceTitle(p)} className={className} />
}

/**
 * An employee avatar with their live status notched into the bottom-right.
 *
 * Reads presence from context, so a caller only ever passes identity — no
 * surface has to know how a dot is derived, and none of them can disagree.
 * Renders a plain avatar when presence is unavailable (pre-migration), which
 * is exactly how these screens looked before this feature.
 */
export function PresenceAvatar({
  employeeId, avatarUrl, name, cqid, size = 36, rounded = 'full', className = '',
  showDot = true, dotSize,
}: {
  employeeId: string | null | undefined
  avatarUrl?: string | null
  name?: string | null
  cqid?: string | null
  size?: number
  rounded?: 'full' | 'xl' | 'lg'
  className?: string
  showDot?: boolean
  dotSize?: DotSize
}) {
  // Scale the dot with the avatar — a fixed dot looks like a bug at 64px and
  // swallows the face at 20px.
  const auto: DotSize = size >= 56 ? 'lg' : size >= 36 ? 'md' : size >= 24 ? 'sm' : 'xs'

  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      <EmployeeAvatar avatarUrl={avatarUrl} name={name} cqid={cqid} size={size} rounded={rounded} />
      {showDot && (
        <EmployeePresenceDot
          employeeId={employeeId}
          size={dotSize ?? auto}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
    </span>
  )
}

/** The note someone set for themselves ("🌴 On leave"), or nothing. */
export function PresenceNote({
  presence, className = '', max = 28,
}: {
  presence: EffectivePresence
  className?: string
  /** Truncation point — these sit in tight rows next to names. */
  max?: number
}) {
  const text = presence.note ?? ''
  if (!presence.emoji && !text) return null
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text
  return (
    <span
      title={[presence.emoji, text].filter(Boolean).join(' ')}
      className={cn('inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground', className)}
    >
      {presence.emoji && <span aria-hidden>{presence.emoji}</span>}
      {short && <span className="truncate">{short}</span>}
    </span>
  )
}

/** Dot + label, for lists that have room for words. */
export function PresenceBadge({
  presence, className = '', showNote = true,
}: {
  presence: EffectivePresence
  className?: string
  showNote?: boolean
}) {
  const { available } = usePresence()
  const meta = STATUS_META[presence.status]
  // Same rule as the dot: no presence system, no claim about anyone.
  if (!available) return null
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <PresenceDot status={presence.status} size="sm" ring={false} title="" />
      <span className={`whitespace-nowrap text-xs font-medium ${meta.text}`}>{meta.label}</span>
      {showNote && <PresenceNote presence={presence} className="ml-0.5" />}
    </span>
  )
}
