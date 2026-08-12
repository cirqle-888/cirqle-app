'use client'

/**
 * <SoundToggle> — mute/unmute the app-wide notification sound and pick which
 * sound plays (device-local, stored in localStorage). Sits beside <PushToggle>
 * in the bell dropdown. Changing anything plays the result once so the user
 * hears what they chose. The "Custom" option only appears when the workspace
 * ships a file at /sounds/notification.mp3 (see public/sounds/README.md).
 */

import { useEffect, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import {
  CHIME_PREF_EVENT, CUSTOM_SOUND_URL, SOUND_OPTIONS, type SoundName,
  getSoundName, isChimeEnabled, playChime, setChimeEnabled, setSoundName,
} from '@/lib/notifications/chime'

export function SoundToggle({ className = '' }: { className?: string }) {
  const [on, setOn] = useState(true)
  const [sound, setSound] = useState<SoundName>('chime')
  const [hasCustom, setHasCustom] = useState(false)

  useEffect(() => {
    // Deferred — no sync setState in an effect body (react-compiler lint rule).
    const t = setTimeout(() => { setOn(isChimeEnabled()); setSound(getSoundName()) }, 0)
    const onPref = () => { setOn(isChimeEnabled()); setSound(getSoundName()) }
    window.addEventListener(CHIME_PREF_EVENT, onPref)
    // Offer "Custom" only when the workspace actually ships the file.
    fetch(CUSTOM_SOUND_URL, { method: 'HEAD' })
      .then(r => setHasCustom(r.ok))
      .catch(() => setHasCustom(false))
    return () => { clearTimeout(t); window.removeEventListener(CHIME_PREF_EVENT, onPref) }
  }, [])

  const toggle = () => {
    const next = !on
    setChimeEnabled(next)
    if (next) playChime({ force: true })
  }

  const pick = (name: SoundName) => {
    setSoundName(name)
    playChime({ force: true, sound: name })
  }

  const options = SOUND_OPTIONS.filter(o => o.value !== 'custom' || hasCustom)

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <button
        onClick={toggle}
        title={on ? 'Notification sound on — click to mute' : 'Notification sound muted — click to unmute'}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
          on
            ? 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
            : 'bg-muted text-muted-foreground hover:text-foreground'
        }`}
      >
        {on ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
        {on ? 'Sound' : 'Muted'}
      </button>
      {on && (
        <select
          value={sound}
          onChange={e => pick(e.target.value as SoundName)}
          title="Notification sound"
          className="rounded-lg border-0 bg-muted px-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none"
        >
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </span>
  )
}
