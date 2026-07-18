'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { X, Lock, Unlock, Eye, EyeOff, ShieldCheck } from 'lucide-react'

// ─────────────────────────────────────────────────────
// Context types
// ─────────────────────────────────────────────────────
interface PrivacyContextType {
  isUnlocked: boolean
  openUnlockModal: () => void
  lock: () => void
  /** Returns name when unlocked, CQID when locked */
  dn: (emp: { cqid?: string | null; name?: string | null } | null | undefined) => string
  /** Returns value when unlocked, masked string when locked */
  ds: (value: string | null | undefined, mask?: string) => string
  /** When true, names are always hidden regardless of unlock state */
  forceLock: boolean
  /** Enable/disable forced lock mode (persists in localStorage) */
  setForceLockMode: (v: boolean) => void
}

const PrivacyContext = createContext<PrivacyContextType>({
  isUnlocked: false,
  openUnlockModal: () => {},
  lock: () => {},
  dn: (emp) => emp?.cqid || '—',
  ds: (_, mask) => mask || '••••••',
  forceLock: false,
  setForceLockMode: () => {},
})

export function usePrivacy() {
  return useContext(PrivacyContext)
}

// ─────────────────────────────────────────────────────
// PIN storage helpers (localStorage)
// ─────────────────────────────────────────────────────
export const PRIVACY_PIN_KEY = 'cirqle_privacy_pin'
export const PRIVACY_FORCE_LOCK_KEY = 'cirqle_privacy_force_lock'

export function getStoredPin(): string {
  try { return localStorage.getItem(PRIVACY_PIN_KEY) || '' } catch { return '' }
}
export function setStoredPin(pin: string) {
  try { localStorage.setItem(PRIVACY_PIN_KEY, pin) } catch { /* ignore */ }
}

export function isForceLocked(): boolean {
  try { return localStorage.getItem(PRIVACY_FORCE_LOCK_KEY) === '1' } catch { return false }
}
export function setForceLocked(v: boolean) {
  try { localStorage.setItem(PRIVACY_FORCE_LOCK_KEY, v ? '1' : '0') } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Unlock Modal
// ─────────────────────────────────────────────────────
function UnlockModal({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [showPin, setShowPin] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const stored = getStoredPin()
    if (!stored) {
      // No PIN set yet — first time setup, accept anything and save it
      if (pin.length < 4) { setError('PIN must be at least 4 characters'); return }
      setStoredPin(pin)
      onSuccess()
      return
    }
    if (pin === stored) {
      setError('')
      onSuccess()
    } else {
      setError('Incorrect PIN. Try again.')
      setPin('')
    }
  }

  const stored = getStoredPin()

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center">
              <Lock className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-sm">Privacy Unlock</h2>
              <p className="text-[11px] text-muted-foreground">
                {stored ? 'Enter your privacy PIN to reveal employee details' : 'Set a PIN to protect employee details'}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {!stored && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs text-amber-300">
              <strong>First time setup:</strong> Create a privacy PIN to protect employee names and personal details. You&apos;ll need this PIN every time you want to see real names.
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              {stored ? 'Enter Privacy PIN' : 'Create Privacy PIN (min. 4 characters)'}
            </label>
            <div className="relative">
              <input
                type={showPin ? 'text' : 'password'}
                value={pin}
                onChange={e => { setPin(e.target.value); setError('') }}
                autoFocus
                autoComplete="off"
                placeholder={stored ? '••••••' : 'e.g. 1234 or a word'}
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/50 pr-10"
              />
              <button type="button" onClick={() => setShowPin(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
          </div>

          <button type="submit"
            className="w-full gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-2">
            <Unlock className="w-4 h-4" />
            {stored ? 'Unlock' : 'Set PIN & Unlock'}
          </button>

          <p className="text-[11px] text-muted-foreground/50 text-center">
            Session only — locks automatically when you close the browser tab.
          </p>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────
export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [forceLock, setForceLock] = useState(false)

  useEffect(() => {
    setForceLock(isForceLocked())
  }, [])

  const effectivelyUnlocked = isUnlocked && !forceLock

  const lock = useCallback(() => setIsUnlocked(false), [])
  const openUnlockModal = useCallback(() => {
    if (forceLock) return
    setShowModal(true)
  }, [forceLock])

  const setForceLockMode = useCallback((v: boolean) => {
    setForceLocked(v)
    setForceLock(v)
    if (v) setIsUnlocked(false)
  }, [])

  const dn = useCallback(
    (emp: { cqid?: string | null; name?: string | null } | null | undefined): string => {
      if (!emp) return '—'
      return effectivelyUnlocked ? (emp.name || emp.cqid || '—') : (emp.cqid || '—')
    },
    [effectivelyUnlocked]
  )

  const ds = useCallback(
    (value: string | null | undefined, mask = '••••••'): string => {
      if (!value) return '—'
      return effectivelyUnlocked ? value : mask
    },
    [effectivelyUnlocked]
  )

  return (
    <PrivacyContext.Provider value={{ isUnlocked: effectivelyUnlocked, openUnlockModal, lock, dn, ds, forceLock, setForceLockMode }}>
      {children}
      {showModal && !forceLock && (
        <UnlockModal
          onSuccess={() => { setIsUnlocked(true); setShowModal(false) }}
          onClose={() => setShowModal(false)}
        />
      )}
    </PrivacyContext.Provider>
  )
}

// ─────────────────────────────────────────────────────
// Lock status badge (reusable)
// ─────────────────────────────────────────────────────
export function PrivacyBadge() {
  const { isUnlocked, openUnlockModal, lock, forceLock } = usePrivacy()
  if (forceLock) {
    return (
      <span
        title="Privacy enforced by settings — names cannot be unlocked"
        className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border bg-amber-500/10 border-amber-500/25 text-amber-400">
        <Lock className="w-3 h-3" /> Locked (enforced)
      </span>
    )
  }
  return (
    <button
      onClick={isUnlocked ? lock : openUnlockModal}
      title={isUnlocked ? 'Names visible — click to lock' : 'Names hidden — click to unlock'}
      className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-all ${
        isUnlocked
          ? 'bg-green-500/10 border-green-500/25 text-green-400 hover:bg-red-500/10 hover:border-red-500/25 hover:text-red-400'
          : 'bg-secondary border-border text-muted-foreground hover:border-primary/30 hover:text-foreground'
      }`}>
      {isUnlocked ? <ShieldCheck className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
      {isUnlocked ? 'Names visible' : 'Names hidden'}
    </button>
  )
}
