/**
 * Shared notification sound for the whole app (browser + the Cirqle Desktop
 * shell, which loads this same web app and allows audio without a gesture).
 *
 * One module owns the sound so every surface (comms widget, chat page, bell)
 * plays the exact same tone, respects the same on/off + sound-choice
 * preference, and a burst of realtime events can't machine-gun the speaker
 * (min 1.5s between plays).
 *
 * Sounds: four built-in WebAudio presets (no asset files needed), plus a
 * "custom" option that plays /sounds/notification.mp3 when the workspace ships
 * one (see public/sounds/README.md) and falls back to the default chime when
 * the file is missing or fails to decode.
 *
 * Browsers block audio until the first user gesture — installChimeUnlock
 * pre-creates and resumes the AudioContext on the first pointer/key event so
 * sounds that arrive later actually play.
 */

const PREF_KEY = 'cirqle.notifySound'
const SOUND_KEY = 'cirqle.notifySoundName'
/** Fired on window whenever any sound preference changes — listeners re-read the getters. */
export const CHIME_PREF_EVENT = 'cirqle:notifySound'
/** Where the optional workspace-provided sound lives (public/sounds/). */
export const CUSTOM_SOUND_URL = '/sounds/notification.mp3'

export type SoundName = 'chime' | 'ding' | 'bell' | 'pop' | 'custom'

export const SOUND_OPTIONS: Array<{ value: SoundName; label: string }> = [
  { value: 'chime', label: 'Chime' },
  { value: 'ding', label: 'Ding' },
  { value: 'bell', label: 'Bell' },
  { value: 'pop', label: 'Pop' },
  { value: 'custom', label: 'Custom' },
]

/** One oscillator within a preset: frequency, start offset, stop time, shape, peak gain. */
interface Tone { freq: number; at: number; stop: number; type?: OscillatorType; peak?: number }

const PRESETS: Record<Exclude<SoundName, 'custom'>, Tone[]> = {
  // Soft E6→A6 double note — reads as "message", not "error".
  chime: [
    { freq: 1318.5, at: 0, stop: 0.5, peak: 0.12 },
    { freq: 1760, at: 0.11, stop: 0.5, peak: 0.12 },
  ],
  // Single clear G6.
  ding: [{ freq: 1567.98, at: 0, stop: 0.7, peak: 0.14 }],
  // A5 with quiet harmonics for a bell-ish ring.
  bell: [
    { freq: 880, at: 0, stop: 0.9, peak: 0.15 },
    { freq: 1760, at: 0, stop: 0.9, peak: 0.05 },
    { freq: 2637, at: 0, stop: 0.9, peak: 0.02 },
  ],
  // Two short low blips — the most discreet option.
  pop: [
    { freq: 523.25, at: 0, stop: 0.12, type: 'triangle', peak: 0.2 },
    { freq: 783.99, at: 0.06, stop: 0.2, type: 'triangle', peak: 0.15 },
  ],
}

let ctx: AudioContext | null = null
let customAudio: HTMLAudioElement | null = null
let lastChimeAt = 0

export function isChimeEnabled(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== 'off' } catch { return true }
}

export function setChimeEnabled(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off') } catch { /* private mode — session-only */ }
  window.dispatchEvent(new CustomEvent(CHIME_PREF_EVENT))
}

export function getSoundName(): SoundName {
  try {
    const v = localStorage.getItem(SOUND_KEY)
    if (v && SOUND_OPTIONS.some(o => o.value === v)) return v as SoundName
  } catch { /* private mode */ }
  return 'chime'
}

export function setSoundName(name: SoundName): void {
  try { localStorage.setItem(SOUND_KEY, name) } catch { /* private mode — session-only */ }
  window.dispatchEvent(new CustomEvent(CHIME_PREF_EVENT))
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try { ctx ??= new AudioContext() } catch { return null }
  return ctx
}

/**
 * Resume the shared AudioContext on the first user gesture (autoplay policy).
 * Mount once from an app-wide client component; returns a cleanup.
 */
export function installChimeUnlock(): () => void {
  const unlock = () => {
    const c = ensureCtx()
    if (c && c.state === 'suspended') void c.resume().catch(() => {})
  }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
  return () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
}

function playPreset(name: Exclude<SoundName, 'custom'>): void {
  const c = ensureCtx()
  if (!c) return
  if (c.state === 'suspended') { void c.resume().catch(() => {}) }
  if (c.state !== 'running') return // still gesture-locked — silent this time
  try {
    const t0 = c.currentTime
    for (const tone of PRESETS[name]) {
      const gain = c.createGain()
      gain.connect(c.destination)
      gain.gain.setValueAtTime(0.0001, t0 + tone.at)
      gain.gain.exponentialRampToValueAtTime(tone.peak ?? 0.12, t0 + tone.at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.stop)
      const osc = c.createOscillator()
      osc.type = tone.type ?? 'sine'
      osc.frequency.value = tone.freq
      osc.connect(gain)
      osc.start(t0 + tone.at)
      osc.stop(t0 + tone.stop)
    }
  } catch { /* audio unavailable — fine */ }
}

function playCustom(): void {
  try {
    customAudio ??= new Audio(CUSTOM_SOUND_URL)
    customAudio.volume = 0.6
    customAudio.currentTime = 0
    // Missing/undecodable file (or autoplay-blocked) → default chime instead
    // of silence, so "Custom" without a file never mutes the app.
    void customAudio.play().catch(() => playPreset('chime'))
  } catch { playPreset('chime') }
}

/** Play the selected notification sound. No-op when muted, throttled, or audio is still gesture-locked. */
export function playChime(opts?: { force?: boolean; sound?: SoundName }): void {
  if (!opts?.force && !isChimeEnabled()) return
  const now = Date.now()
  if (now - lastChimeAt < 1500) return
  lastChimeAt = now
  const name = opts?.sound ?? getSoundName()
  if (name === 'custom') playCustom()
  else playPreset(name)
}
