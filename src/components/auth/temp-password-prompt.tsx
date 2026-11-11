'use client'

/**
 * Shown once after someone signs in with a temporary password an admin gave
 * them. Optional: they can set their own, keep the temporary one for good,
 * or skip it until next time. See lib/auth/temp-password.ts.
 */

import { useEffect, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { hasTemporaryPassword, newPasswordError, MIN_PASSWORD_LENGTH } from '@/lib/auth/temp-password'
import { finishTemporaryPassword } from '@/lib/auth/temp-password-actions'

/** "Not now" lasts for this browser session; the next sign-in asks again. */
const LATER_KEY = 'cirqle.tempPassword.later'

export function TempPasswordPrompt() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'save' | 'keep' | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    try { if (sessionStorage.getItem(LATER_KEY) === '1') return } catch { /* storage blocked — ask anyway */ }
    // getUser asks the auth server, so a flag set by a reset is seen even on a
    // session that started before it. Once per full page load.
    createClient().auth.getUser().then(({ data }) => {
      if (!cancelled && hasTemporaryPassword(data.user?.app_metadata)) setOpen(true)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  function later() {
    try { sessionStorage.setItem(LATER_KEY, '1') } catch { /* fine — just closes */ }
    setOpen(false)
  }

  async function finish(newPassword: string | null) {
    if (newPassword !== null) {
      const problem = newPasswordError(password, confirm)
      if (problem) { setError(problem); return }
    }
    setBusy(newPassword === null ? 'keep' : 'save'); setError('')
    const res = await finishTemporaryPassword(newPassword)
    if (!res.ok) { setBusy(null); setError(res.error ?? 'Something went wrong.'); return }
    // Pick up the cleared flag so a reload does not ask again.
    await createClient().auth.refreshSession().catch(() => {})
    setBusy(null)
    if (newPassword === null) { setOpen(false); return }
    setSaved(true)
    window.setTimeout(() => setOpen(false), 1800)
  }

  if (!open) return null

  const field = 'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground'

  return (
    <ModalOverlay onClose={later} zIndex="z-[100]">
      <div className="w-full max-w-sm bg-card border border-border rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Set your own password?</h2>
            <p className="text-xs text-muted-foreground">You signed in with a temporary password.</p>
          </div>
        </div>

        {saved ? (
          <p className="py-4 text-center text-sm font-medium text-emerald-500">Done — use your new password next time.</p>
        ) : (
          <form onSubmit={e => { e.preventDefault(); void finish(password) }} className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Choose one only you know, or keep using the one you were given. This is optional.
            </p>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"
              autoFocus minLength={MIN_PASSWORD_LENGTH} placeholder={`New password (${MIN_PASSWORD_LENGTH}+ characters)`}
              aria-label="New password" className={field} />
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password"
              placeholder="Type it again" aria-label="Confirm new password" className={field} />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <button type="submit" disabled={busy !== null || !password}
              className="w-full inline-flex items-center justify-center gap-1.5 gradient-bg text-white font-medium py-2 rounded-lg text-sm hover:opacity-90 disabled:opacity-50">
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />} Save my password
            </button>
            <div className="flex items-center justify-between pt-1 text-xs">
              <button type="button" onClick={later} disabled={busy !== null} className="text-muted-foreground hover:text-foreground disabled:opacity-50">
                Not now
              </button>
              <button type="button" onClick={() => void finish(null)} disabled={busy !== null} className="text-muted-foreground hover:text-foreground disabled:opacity-50">
                {busy === 'keep' ? 'Saving…' : 'Keep the temporary one'}
              </button>
            </div>
          </form>
        )}
      </div>
    </ModalOverlay>
  )
}
