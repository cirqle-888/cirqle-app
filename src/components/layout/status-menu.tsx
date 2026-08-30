'use client'

/**
 * StatusMenu — "what am I doing right now", for the account dropdown.
 *
 * Two controls, deliberately separate, the way Teams and Slack separate them:
 *
 *   THE DOT   Available / Busy / Do not disturb / Be right back / Appear away
 *             / Appear offline. Or nothing, which means "follow my activity"
 *             and is the default everyone starts on.
 *
 *   THE NOTE  An emoji and a line of text ("🌴 On leave"), with a "clear
 *             after". Independent of the dot: you can be Available with a note,
 *             or set a note and leave the dot automatic.
 *
 * Saving is optimistic — the row the server returns is pushed straight into
 * presence context, so your own dot updates before Realtime echoes it back.
 */

import { useState, useTransition } from 'react'
import { Check, X } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { usePresence } from '@/contexts/presence-context'
import { PresenceDot } from '@/components/ui/presence-dot'
import { setMyStatus } from '@/lib/presence/actions'
import {
  MANUAL_CHOICES, CLEAR_AFTER_OPTIONS, STATUS_META, lastSeenLabel,
  type ClearAfterId, type ManualStatus,
} from '@/lib/presence/status'

/** Slack's trick: a handful of one-tap notes covers most of what people set. */
const NOTE_PRESETS: { emoji: string; text: string; status?: ManualStatus; clearAfter?: ClearAfterId }[] = [
  { emoji: '📅', text: 'In a meeting',   status: 'busy', clearAfter: '1h' },
  { emoji: '🎧', text: 'Focusing',        status: 'dnd',  clearAfter: '4h' },
  { emoji: '🍽️', text: 'Out for lunch',   status: 'brb',  clearAfter: '1h' },
  { emoji: '🏠', text: 'Working remotely', clearAfter: 'today' },
  { emoji: '🌴', text: 'On leave',        status: 'away', clearAfter: 'today' },
  { emoji: '🤒', text: 'Out sick',        status: 'away', clearAfter: 'today' },
]

export function StatusMenu({ onDone }: { onDone?: () => void }) {
  const { user } = usePermissions()
  const { mine, applyRow } = usePresence()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')

  const [emoji, setEmoji] = useState('')
  const [text, setText] = useState('')
  const [clearAfter, setClearAfter] = useState<ClearAfterId>('never')
  const [editingNote, setEditingNote] = useState(false)

  /** Load the stored note into the fields, then open the editor. Seeding on
   *  open rather than mirroring `mine` into state means there is no stale copy
   *  to keep in sync — the collapsed row always reads context directly. */
  function openEditor() {
    setEmoji(mine.emoji ?? '')
    setText(mine.note ?? '')
    setEditingNote(true)
  }

  function save(patch: {
    status?: ManualStatus | null
    emoji?: string | null
    text?: string | null
    clearAfter?: ClearAfterId
  }, close = false) {
    setError('')
    startTransition(async () => {
      const res = await setMyStatus({
        // Unspecified fields keep what is already set — the dot and the note
        // are edited independently, so neither may silently wipe the other.
        status: patch.status !== undefined ? patch.status : mine.manual,
        emoji: patch.emoji !== undefined ? patch.emoji : mine.emoji,
        text: patch.text !== undefined ? patch.text : mine.note,
        clearAfter: patch.clearAfter,
      })
      if (!res.ok) { setError(res.error); return }
      applyRow(res.row)
      setEditingNote(false)
      if (close) onDone?.()
    })
  }

  const hasSomethingSet = !!mine.manual || !!mine.note || !!mine.emoji
  const seen = lastSeenLabel(mine)

  return (
    <div className="text-sm">
      {/* ── Where I stand right now ───────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 pb-2">
        <PresenceDot status={mine.status} size="md" ring={false} title="" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">
            {STATUS_META[mine.status].label}
            {mine.isAuto && mine.manual === null && (
              <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">auto</span>
            )}
          </div>
          {seen && <div className="truncate text-xs text-muted-foreground">{seen}</div>}
        </div>
        {hasSomethingSet && (
          <button
            type="button"
            disabled={pending}
            onClick={() => save({ status: null, emoji: null, text: null, clearAfter: 'never' })}
            className="shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            title="Back to following my activity"
          >
            Reset
          </button>
        )}
      </div>

      {/* ── The dot ───────────────────────────────────────────────────────── */}
      <div className="border-t border-border/50 pt-1">
        {MANUAL_CHOICES.map(choice => {
          const active = mine.manual === choice.status
          return (
            <button
              key={choice.status}
              type="button"
              disabled={pending}
              onClick={() => save({ status: active ? null : choice.status }, true)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/80 disabled:opacity-50"
            >
              <PresenceDot status={choice.status} size="sm" ring={false} title="" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{choice.label}</span>
              {active && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
            </button>
          )
        })}
      </div>

      {/* ── The note ──────────────────────────────────────────────────────── */}
      <div className="mt-1 border-t border-border/50 pt-2">
        {!editingNote ? (
          <button
            type="button"
            onClick={openEditor}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/80"
          >
            <span className="text-base leading-none">{mine.emoji || '💬'}</span>
            <span className={`min-w-0 flex-1 truncate text-[13px] ${mine.note ? 'text-foreground' : 'text-muted-foreground'}`}>
              {mine.note || 'Set a status message'}
            </span>
          </button>
        ) : (
          <div className="px-2 pb-1">
            <div className="flex flex-wrap gap-1 pb-2">
              {NOTE_PRESETS.map(p => (
                <button
                  key={p.text}
                  type="button"
                  disabled={pending}
                  onClick={() => save({
                    emoji: p.emoji, text: p.text,
                    status: p.status ?? mine.manual,
                    clearAfter: p.clearAfter,
                  }, true)}
                  title={p.text}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/40 px-2 py-1 text-[11px] transition-colors hover:border-primary/40 hover:bg-secondary disabled:opacity-50"
                >
                  <span aria-hidden>{p.emoji}</span>
                  <span className="max-w-24 truncate">{p.text}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 focus-within:border-primary/50">
              <input
                value={emoji}
                onChange={e => setEmoji(e.target.value.slice(0, 8))}
                aria-label="Status emoji"
                placeholder="💬"
                className="w-7 shrink-0 bg-transparent text-center text-base outline-none"
              />
              <input
                value={text}
                onChange={e => setText(e.target.value.slice(0, 80))}
                onKeyDown={e => { if (e.key === 'Enter') save({ emoji: emoji || null, text: text || null, clearAfter }, true) }}
                aria-label="Status message"
                placeholder="What's your status?"
                maxLength={80}
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {(emoji || text) && (
                <button
                  type="button"
                  onClick={() => { setEmoji(''); setText('') }}
                  aria-label="Clear message"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2">
              <label className="shrink-0 text-[11px] text-muted-foreground" htmlFor="status-clear-after">
                Clear after
              </label>
              <select
                id="status-clear-after"
                value={clearAfter}
                onChange={e => setClearAfter(e.target.value as ClearAfterId)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-1 text-[12px] outline-none focus:border-primary/50"
              >
                {CLEAR_AFTER_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => { setEditingNote(false); setEmoji(mine.emoji ?? ''); setText(mine.note ?? '') }}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => save({ emoji: emoji || null, text: text || null, clearAfter }, true)}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <p className="px-2 pt-1 text-xs text-destructive">{error}</p>}
      {!user.employeeId && (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          Status needs an employee record on your account.
        </p>
      )}
    </div>
  )
}
