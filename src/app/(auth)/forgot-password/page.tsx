'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { getCompanyLogo } from '../login/actions'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  // Same workspace-logo fetch as the login page — this screen hard-coded the
  // default "C" mark regardless of what's uploaded in Settings → Company.
  // Fails silently if no logo is configured; placeholder stays visible.
  useEffect(() => {
    let cancelled = false
    getCompanyLogo()
      .then(url => { if (!cancelled) setLogoUrl(url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    // The reset link is built from the CONFIGURED app URL, not from wherever
    // this page happens to be served.
    //
    // It used to use window.location.origin, which is right until someone
    // requests a reset from a non-production origin — a developer on
    // localhost:3000, or a preview deployment. The email then carries a link
    // only that machine can open, and the person who receives it cannot sign
    // in at all. That is exactly what happened: a real reset email arrived
    // pointing at http://localhost:3000/?error=... .
    //
    // Same precedence the rest of the app already uses for outbound URLs (see
    // api/auth/google/login, lib/requests/notify): configured value first,
    // current origin only as a fallback when it is unset.
    const origin = process.env.NEXT_PUBLIC_APP_URL
      || (typeof window !== 'undefined' ? window.location.origin : '')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/reset-password`,
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSent(true)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
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
          <p className="text-muted-foreground text-sm">Reset your password</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl">
          {sent ? (
            <div className="space-y-4 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <span className="text-2xl">✉️</span>
              </div>
              <h2 className="text-lg font-semibold">Check your email</h2>
              <p className="text-sm text-muted-foreground">
                We&apos;ve sent a password reset link to <strong className="text-foreground">{email}</strong>.
                The link is valid for 1 hour.
              </p>
              <Link href="/login" className="block text-sm text-primary hover:underline pt-2">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter your email and we&apos;ll send you a link to set a new password.
              </p>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Email address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
                  placeholder="you@cirqle.in"
                />
              </div>

              {error && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full gradient-bg text-white font-medium py-2.5 rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed mt-2"
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>

              <Link
                href="/login"
                className="block text-center text-sm text-muted-foreground hover:text-foreground transition-colors pt-1"
              >
                Back to sign in
              </Link>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Cirqle Works © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
