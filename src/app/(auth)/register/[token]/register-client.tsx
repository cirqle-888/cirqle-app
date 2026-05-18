'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { completeRegistration } from './actions'
import { AvatarPicker } from '@/components/ui/employee-avatar'

interface Props {
  token: string
  employee: {
    id: string
    cqid: string
    name: string
    email: string
    phone: string
    designationName: string | null
  }
}

export default function RegisterClient({ token, employee }: Props) {
  const router = useRouter()
  const [email, setEmail]               = useState(employee.email)
  const [password, setPassword]         = useState('')
  const [confirm, setConfirm]           = useState('')
  const [name, setName]                 = useState(employee.name)
  const [phone, setPhone]               = useState(employee.phone)
  const [dob, setDob]                   = useState('')
  const [emerName, setEmerName]         = useState('')
  const [emerPhone, setEmerPhone]       = useState('')
  const [avatarUrl, setAvatarUrl]       = useState<string | null>(null)
  const [error, setError]               = useState('')
  const [loading, setLoading]           = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    const res = await completeRegistration({
      token,
      email,
      password,
      name,
      phone,
      dateOfBirth: dob,
      emergencyContactName: emerName,
      emergencyContactPhone: emerPhone,
      avatarUrl,
    })
    setLoading(false)
    if (!res.ok) {
      setError(res.error || 'Could not complete registration.')
      return
    }
    if (res.error) {
      // Account created but auto-login failed
      router.push('/login?registered=1')
      return
    }
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-10 h-10 rounded-xl gradient-bg flex items-center justify-center">
              <span className="text-white font-bold text-lg">C</span>
            </div>
            <span className="text-2xl font-bold gradient-text">Cirqle</span>
          </div>
          <p className="text-muted-foreground text-sm">Complete your registration</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl">
          {/* Employee badge */}
          <div className="flex items-center gap-3 pb-4 mb-4 border-b border-border">
            <div className="flex-1">
              <div className="text-xs text-muted-foreground">Your employee ID</div>
              <div className="font-mono font-semibold text-primary">{employee.cqid}</div>
            </div>
            {employee.designationName && (
              <div className="text-right">
                <div className="text-xs text-muted-foreground">Designation</div>
                <div className="text-sm font-medium">{employee.designationName}</div>
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Avatar picker */}
            <Section title="Profile photo" subtitle="Optional — you can change this later">
              <AvatarPicker
                value={avatarUrl}
                onChange={setAvatarUrl}
                name={name}
                cqid={employee.cqid}
              />
            </Section>

            <Section title="Account">
              <Field label="Email address" required>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Password" required>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className={inputCls}
                  placeholder="At least 8 characters"
                />
              </Field>
              <Field label="Confirm password" required>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  className={inputCls}
                  placeholder="Re-enter password"
                />
              </Field>
            </Section>

            <Section title="Personal details">
              <Field label="Full name" required>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="Your full name"
                />
              </Field>
              <Field label="Phone" required>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="+91 9XXXX XXXXX"
                />
              </Field>
              <Field label="Date of birth" required>
                <input
                  type="date"
                  value={dob}
                  onChange={e => setDob(e.target.value)}
                  required
                  max={new Date().toISOString().slice(0, 10)}
                  className={inputCls}
                />
              </Field>
            </Section>

            <Section title="Emergency contact">
              <Field label="Contact name" required>
                <input
                  type="text"
                  value={emerName}
                  onChange={e => setEmerName(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="e.g. Parent / spouse"
                />
              </Field>
              <Field label="Contact phone" required>
                <input
                  type="tel"
                  value={emerPhone}
                  onChange={e => setEmerPhone(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="+91 9XXXX XXXXX"
                />
              </Field>
            </Section>

            {error && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                {error}
                {error.includes('already exists') && (
                  <span> <Link href="/forgot-password" className="underline font-medium">Forgot your password?</Link></span>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full gradient-bg text-white font-medium py-2.5 rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating account…' : 'Complete registration'}
            </button>

            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="text-primary hover:underline">Sign in</Link>
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

const inputCls =
  'w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors'

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {subtitle && <span className="text-[11px] text-muted-foreground/60">{subtitle}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}
