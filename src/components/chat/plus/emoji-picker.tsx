'use client'

import { useState } from 'react'
import { EMOJI_GROUPS } from './emoji-data'

const RECENT_KEY = 'chat_recent_emoji'
function readRecent(): string[] {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as string[]).slice(0, 16) } catch { return [] }
}
export function rememberEmoji(e: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...readRecent().filter(x => x !== e)].slice(0, 16))) } catch { /* fine */ }
}

/** A grid of emoji with category tabs and the ones you used last. */
export function EmojiPicker({ onPick, className = '' }: { onPick: (emoji: string) => void; className?: string }) {
  const [tab, setTab] = useState(0)
  const [recent] = useState(readRecent)
  const pick = (e: string) => { rememberEmoji(e); onPick(e) }
  const cell = 'flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-muted active:scale-90 transition-transform'
  return (
    <div className={`w-full ${className}`}>
      <div className="flex gap-1 border-b border-border px-2 pb-1.5">
        {EMOJI_GROUPS.map((g, i) => (
          <button key={g.label} type="button" onClick={() => setTab(i)} aria-label={g.label} title={g.label}
            className={`flex h-8 flex-1 items-center justify-center rounded-lg text-lg ${tab === i ? 'bg-muted' : 'opacity-60 hover:opacity-100'}`}>
            {g.icon}
          </button>
        ))}
      </div>
      <div className="h-52 overflow-y-auto overscroll-contain px-2 py-2">
        {tab === 0 && recent.length > 0 && (
          <>
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Recent</p>
            <div className="mb-2 grid grid-cols-8 gap-0.5">
              {recent.map(e => <button key={`r-${e}`} type="button" className={cell} onClick={() => pick(e)}>{e}</button>)}
            </div>
          </>
        )}
        <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{EMOJI_GROUPS[tab].label}</p>
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_GROUPS[tab].emoji.map(e => <button key={e} type="button" className={cell} onClick={() => pick(e)}>{e}</button>)}
        </div>
      </div>
    </div>
  )
}
