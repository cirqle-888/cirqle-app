'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { resolveLoginEmail, getCompanyLogo, recordLoginActivity } from './actions'

const REMEMBER_KEY = 'cirqle-login-id'

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  // `identifier` accepts an email OR a CQID (e.g. "CQID001"). A server
  // action resolves CQID → real email before the actual auth call.
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const archivedFlag = searchParams.get('archived') === '1'

  // Pre-fill the identifier from the last successful login on this device.
  // If we have a remembered identifier, jump focus straight to the password
  // field so returning users only have to type their password.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_KEY)
      if (saved) {
        setIdentifier(saved)
        // Focus password after React paints the value into the field.
        setTimeout(() => passwordRef.current?.focus(), 0)
      }
    } catch {}
    setHydrated(true)
  }, [])

  // Fetch the workspace logo (set in Settings → Company) so the login
  // screen reflects the actual brand instead of the default Cirqle "C".
  // Fails silently if no logo is configured — placeholder stays visible.
  useEffect(() => {
    let cancelled = false
    getCompanyLogo()
      .then(url => { if (!cancelled) setLogoUrl(url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    // Step 1: resolve CQID → email (server action). For plain emails this
    // is a no-op pass-through, so we always call it for a single code path.
    const resolved = await resolveLoginEmail(identifier)
    if (!resolved.ok) {
      setError(resolved.error)
      setLoading(false)
      return
    }

    // Step 2: actual Supabase auth — runs in the browser so the session
    // cookies are set on this device exactly like before.
    const supabase = createClient()
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: resolved.email,
      password,
    })
    if (authErr) {
      setError(authErr.message)
      setLoading(false)
      return
    }

    // Timeline: record the sign-in (fire-and-forget; resolved server-side)
    void recordLoginActivity()

    // Step 3: persist the typed identifier (CQID or email — whichever the
    // user prefers) for next time, or clear it if they unchecked the box.
    try {
      if (remember) window.localStorage.setItem(REMEMBER_KEY, identifier.trim())
      else window.localStorage.removeItem(REMEMBER_KEY)
    } catch {}

    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo — uses the workspace's uploaded logo (Settings → Company →
            Upload logo) when available; otherwise falls back to the default
            Cirqle brand mark so first-run installs still look polished. */}
        <div className="text-center mb-8">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt="Workspace logo"
              className="mx-auto mb-4 h-14 max-w-[200px] object-contain"
              onError={() => setLogoUrl(null)}
            />
          ) : (
            <div className="inline-flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center">
                <span className="text-white font-bold text-lg">C</span>
              </div>
              <span className="text-2xl font-bold gradient-text">Cirqle</span>
            </div>
          )}
          <p className="text-muted-foreground text-sm">Sign in to your workspace</p>
        </div>

        {archivedFlag && (
          <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-sm text-amber-300">
            Your account has been archived. Contact your administrator if this is unexpected.
          </div>
        )}

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Email or CQID
              </label>
              <input
                type="text"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                autoComplete="username"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
                placeholder="you@cirqle.work  or  CQID00X"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-foreground">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-primary hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              {/* Wrapper holds the input + the show/hide eye toggle.
                  Padding-right on the input reserves space for the icon button. */}
              <div className="relative">
                <input
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full bg-secondary border border-border rounded-lg pl-3 pr-10 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Remember me — pre-fills the identifier next time and skips
                straight to the password field so returning users don't have
                to retype their email/CQID. The password itself is NEVER
                stored client-side; the browser handles that via
                autocomplete="current-password" if the user opts in. */}
            <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
                className="w-4 h-4 rounded border-border bg-secondary text-primary focus:ring-2 focus:ring-primary/50"
              />
              Remember me on this device
            </label>

            {error && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !hydrated}
              className="w-full gradient-bg text-white font-medium py-2.5 rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed mt-2"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>

            <p className="text-center text-xs text-muted-foreground pt-1">
              You'll stay signed in on this device.
            </p>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Cirqle Design © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
