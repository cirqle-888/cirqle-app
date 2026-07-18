'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { completeRegistration } from './actions'
import { AvatarPicker } from '@/components/ui/employee-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
              <div className="space-y-1.5">
                <Label htmlFor="email" required>Email address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" required>Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm" required>Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Re-enter password"
                />
              </div>
            </Section>

            <Section title="Personal details">
              <div className="space-y-1.5">
                <Label htmlFor="name" required>Full name</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  placeholder="Your full name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone" required>Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  required
                  placeholder="+91 9XXXX XXXXX"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dob" required>Date of birth</Label>
                <Input
                  id="dob"
                  type="date"
                  value={dob}
                  onChange={e => setDob(e.target.value)}
                  required
                  max={new Date().toISOString().slice(0, 10)}
                />
              </div>
            </Section>

            <Section title="Emergency contact">
              <div className="space-y-1.5">
                <Label htmlFor="emerName" required>Contact name</Label>
                <Input
                  id="emerName"
                  type="text"
                  value={emerName}
                  onChange={e => setEmerName(e.target.value)}
                  required
                  placeholder="e.g. Parent / spouse"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emerPhone" required>Contact phone</Label>
                <Input
                  id="emerPhone"
                  type="tel"
                  value={emerPhone}
                  onChange={e => setEmerPhone(e.target.value)}
                  required
                  placeholder="+91 9XXXX XXXXX"
                />
              </div>
            </Section>

            {error && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-sm text-destructive">
                {error}
                {error.includes('already exists') && (
                  <span> <Link href="/forgot-password" className="underline font-medium">Forgot your password?</Link></span>
                )}
              </div>
            )}

            <Button
              type="submit"
              loading={loading}
              className="w-full bg-gradient-to-r from-primary to-violet-600 text-primary-foreground hover:from-primary/90 hover:to-violet-600/90"
              size="lg"
            >
              Complete registration
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="text-primary hover:underline">Sign in</Link>
            </p>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Cirqle Works © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {subtitle && <span className="text-[11px] text-muted-foreground/60">{subtitle}</span>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
