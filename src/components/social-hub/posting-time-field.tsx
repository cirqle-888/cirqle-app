'use client'

/**
 * The posting time, on the planning screen.
 *
 * Optional by design. Planning is the first thing that happens and the time is
 * often not known yet, so an empty field is a valid answer and the row saves
 * without it. What the field does instead of demanding a value is make the
 * right one cheap: if the client has standing slots, the first free one for
 * that date is offered as a chip, and so is anything their analytics suggest —
 * labelled, so you always know which is which.
 *
 * Suggestions load only when both a client and a date exist. Before that there
 * is nothing truthful to suggest, and guessing would train people to ignore it.
 */

import { useEffect, useMemo, useState } from 'react'
import { Clock, Zap, Loader2, X } from 'lucide-react'
import {
  suggestTimes, formatTime12, normalizeTime,
  TIME_SOURCE_LABEL, type TimeSuggestion, type PostingSlot, type BestTime,
} from '@/lib/social/posting-time'
import { timeSuggestionsFor } from '@/lib/social/posting-actions'

interface Props {
  clientId: string | null | undefined
  isoDate: string | null | undefined
  value: string | null | undefined
  asap?: boolean
  disabled?: boolean
  onChange: (next: { time: string | null; asap: boolean }) => void
}

export function PostingTimeField({ clientId, isoDate, value, asap, disabled, onChange }: Props) {
  /*
    One piece of state holding the answer AND which question it answers.
    Everything else is derived from whether those two agree.

    The obvious shape — separate slots/best/taken/loading, cleared and set at
    the top of the effect — trips react-hooks/set-state-in-effect, and the
    rule is right: clearing in the effect body renders once with stale data
    before the clear lands. Keying the result means a changed client or date
    is stale by definition, with nothing to reset.
  */
  const key = clientId && isoDate ? `${clientId}|${isoDate}` : ''
  const [loaded, setLoaded] = useState<{
    key: string; slots: PostingSlot[]; best: BestTime[]; taken: string[]
  } | null>(null)

  useEffect(() => {
    if (!key || !clientId || !isoDate) return
    let live = true
    timeSuggestionsFor(clientId, isoDate).then(res => {
      if (!live || !res.ok || !res.data) return
      setLoaded({
        key,
        slots: res.data.slots.map(s => ({ ...s, platforms: s.platforms ?? [] })) as PostingSlot[],
        best: res.data.best,
        taken: res.data.taken,
      })
    })
    return () => { live = false }
  }, [key, clientId, isoDate])

  const fresh = loaded?.key === key ? loaded : null
  const loading = !!key && !fresh

  // Derived from `fresh` itself rather than from three `?? []` fallbacks:
  // those build a new array on every render, so the memo would never hold.
  const suggestions: TimeSuggestion[] = useMemo(() => {
    if (!isoDate || !fresh) return []
    try {
      return suggestTimes(isoDate, {
        slots: fresh.slots, bestTimes: fresh.best, taken: fresh.taken, limit: 4,
      })
    } catch { return [] }
  }, [isoDate, fresh])

  const set = (time: string | null) => onChange({ time, asap: false })

  return (
    <div>
      <label className="block text-xs font-medium text-foreground/80 mb-1.5">
        <Clock className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
        Posting time <span className="text-muted-foreground/60">(optional)</span>
      </label>

      <div className="flex items-center gap-1.5">
        <input
          type="time"
          value={asap ? '' : (normalizeTime(value) ?? '')}
          disabled={disabled || asap}
          onChange={e => set(e.target.value || null)}
          className="h-10 flex-1 min-w-0 bg-background border border-border rounded-lg px-3 text-sm focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
        />
        {!disabled && value && !asap && (
          <button
            type="button"
            onClick={() => set(null)}
            className="h-10 px-2 rounded-lg border border-border text-muted-foreground hover:text-foreground"
            title="Clear the time"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {/* ASAP is the absence of a slot, not a time of 00:00 — so it clears
            the field rather than filling it, and the bulk planner skips it. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ time: null, asap: !asap })}
          aria-pressed={!!asap}
          title="Publish as soon as it is approved, with no scheduled slot"
          className={`h-10 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1 shrink-0 transition-colors ${
            asap
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-500'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          <Zap className="w-3.5 h-3.5" /> ASAP
        </button>
      </div>

      {asap ? (
        <p className="text-[11px] text-amber-500/90 mt-1.5">
          Goes out as soon as it is approved. It won&apos;t take a slot, and it won&apos;t appear on
          anyone&apos;s calendar — there is no moment to put there.
        </p>
      ) : loading ? (
        <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Checking this client&apos;s times…
        </p>
      ) : suggestions.length > 0 ? (
        <div className="mt-1.5">
          <div className="flex flex-wrap gap-1">
            {suggestions.map(s => (
              <button
                key={`${s.source}-${s.time}`}
                type="button"
                disabled={disabled}
                onClick={() => set(s.time)}
                title={s.reason + (s.taken ? ' · already used that day' : '')}
                className={`px-2 py-1 rounded-md border text-[11px] transition-colors ${
                  normalizeTime(value) === s.time
                    ? 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                    : s.taken
                      ? 'border-border/60 text-muted-foreground/70 hover:text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-violet-500/40'
                }`}
              >
                {formatTime12(s.time)}
                <span className="ml-1 opacity-60">
                  {s.source === 'slot' ? 'slot' : s.source === 'meta' ? 'IG' : 'shot'}
                </span>
                {s.taken && <span className="ml-1 opacity-50">· taken</span>}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            {suggestions[0].source === 'slot'
              ? TIME_SOURCE_LABEL.slot
              : 'Suggested from this client’s analytics — nothing is set until you pick one.'}
          </p>
        </div>
      ) : clientId && isoDate ? (
        <p className="text-[11px] text-muted-foreground/70 mt-1.5">
          No slots set for this client yet.
        </p>
      ) : null}
    </div>
  )
}
