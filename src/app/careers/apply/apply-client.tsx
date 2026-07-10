'use client'

import React from 'react'
import { FormField, FormLabel, FormControl } from '@/components/ui/form'

import { useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getResumeUploadUrl, submitApplication, type PublicPosition } from './actions'
import { CheckCircle2, Upload, FileText, Loader2 } from 'lucide-react'

interface Props {
  positions: PublicPosition[]
}

const inputCls =
  'w-full bg-secondary border border-foreground/15 rounded-xl px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors'
const labelCls = 'block text-sm font-medium text-foreground mb-1.5'

export default function ApplyClient({ positions }: Props) {
  const [isPending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reference, setReference] = useState<string | null>(null)
  const [resumeFile, setResumeFile] = useState<File | null>(null)

  const [positionId, setPositionId] = useState('')
  const [positionTitle, setPositionTitle] = useState('')

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)

    const fullName = String(form.get('fullName') || '').trim()
    const email = String(form.get('email') || '').trim()
    const finalPositionTitle = positionId
      ? (positions.find(p => p.id === positionId)?.title ?? positionTitle)
      : positionTitle.trim()

    if (!fullName) { setError('Please enter your full name.'); return }
    if (!email) { setError('Please enter your email.'); return }
    if (!finalPositionTitle) { setError('Please select or enter a position.'); return }

    startTransition(async () => {
      let resumeStoragePath: string | null = null
      let resumeMimeType: string | null = null
      let resumeSizeBytes: number | null = null

      if (resumeFile) {
        setUploading(true)
        const prep = await getResumeUploadUrl(resumeFile.name)
        if (!prep.ok) { setUploading(false); setError(prep.error); return }
        const supabase = createClient()
        const { error: upErr } = await supabase.storage
          .from('recruitment-resumes')
          .uploadToSignedUrl(prep.data.storagePath, prep.data.token, resumeFile)
        setUploading(false)
        if (upErr) { setError(`Resume upload failed: ${upErr.message}`); return }
        resumeStoragePath = prep.data.storagePath
        resumeMimeType = resumeFile.type || null
        resumeSizeBytes = resumeFile.size
      }

      const res = await submitApplication({
        positionId: positionId || null,
        positionTitle: finalPositionTitle,
        fullName,
        email,
        phone: String(form.get('phone') || ''),
        country: String(form.get('country') || ''),
        location: String(form.get('location') || ''),
        experience: String(form.get('experience') || ''),
        expectedSalary: form.get('expectedSalary') ? Number(form.get('expectedSalary')) : null,
        availability: String(form.get('availability') || ''),
        portfolioUrl: String(form.get('portfolioUrl') || ''),
        linkedinUrl: String(form.get('linkedinUrl') || ''),
        coverLetter: String(form.get('coverLetter') || ''),
        skills: String(form.get('skills') || ''),
        whyJoin: String(form.get('whyJoin') || ''),
        resumeStoragePath, resumeFileName: resumeFile?.name ?? null, resumeMimeType, resumeSizeBytes,
        website: String(form.get('website') || ''), // honeypot
      })

      if (!res.ok) { setError(res.error); return }
      setReference(res.data.referenceNumber)
    })
  }

  if (reference) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </div>
          <h1 className="text-xl font-semibold mb-2">Application submitted</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Thank you for applying to Cirqle. Our team will review your application and reach out if there&apos;s a fit.
          </p>
          <div className="rounded-xl border border-foreground/15 bg-secondary px-4 py-3 mb-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mb-1">Reference number</div>
            <div className="text-lg font-mono font-semibold text-violet-400">{reference}</div>
          </div>
          <p className="text-xs text-muted-foreground/70">Keep this for your records — no email confirmation is sent.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh py-10 px-4 sm:px-6">
      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold mb-2">Apply to Cirqle</h1>
          <p className="text-sm text-muted-foreground">Tell us about yourself and what you create best. No CV formalities — your work speaks.</p>
        </div>

        {/* Honeypot — hidden from real users, bots fill every field */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off"
          className="absolute -left-[9999px] w-px h-px opacity-0" aria-hidden="true" />

        <div className="space-y-5 rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <Section title="Basics">
            <Field label="Full Name" required><input name="fullName" required className={inputCls} placeholder="Jane Doe" /></Field>
            <Row>
              <Field label="Email" required><input name="email" type="email" required className={inputCls} placeholder="jane@example.com" /></Field>
              <Field label="Phone"><input name="phone" className={inputCls} placeholder="+91 98765 43210" /></Field>
            </Row>
            <Row>
              <Field label="Country"><input name="country" className={inputCls} placeholder="India" /></Field>
              <Field label="Location"><input name="location" className={inputCls} placeholder="Kochi, Kerala" /></Field>
            </Row>
          </Section>

          <Section title="Position">
            <Field label="Position Applying For" required>
              {positions.length > 0 ? (
                <select
                  className={inputCls}
                  value={positionId}
                  onChange={e => { setPositionId(e.target.value); setPositionTitle('') }}
                >
                  <option value="">Select a position…</option>
                  {positions.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.title}{p.department ? ` — ${p.department}` : ''}{p.isRemote ? ' (Remote)' : ''}
                    </option>
                  ))}
                  <option value="">General Application (other)</option>
                </select>
              ) : (
                <input
                  className={inputCls} placeholder="e.g. Graphic Designer, Video Editor, Ad Ops"
                  value={positionTitle} onChange={e => setPositionTitle(e.target.value)}
                />
              )}
            </Field>
            {positions.length > 0 && !positionId && (
              <Field label="If “General Application”, tell us the role">
                <input className={inputCls} placeholder="e.g. Graphic Designer" value={positionTitle} onChange={e => setPositionTitle(e.target.value)} />
              </Field>
            )}
            <Row>
              <Field label="Experience"><input name="experience" className={inputCls} placeholder="e.g. 3 years / Fresher" /></Field>
              <Field label="Expected Salary (optional)"><input name="expectedSalary" type="number" min="0" className={inputCls} placeholder="₹ per month" /></Field>
            </Row>
            <Field label="Availability"><input name="availability" className={inputCls} placeholder="e.g. Immediate, 30 days notice" /></Field>
          </Section>

          <Section title="Portfolio & Links">
            <Row>
              <Field label="Portfolio URL"><input name="portfolioUrl" type="url" className={inputCls} placeholder="https://…" /></Field>
              <Field label="LinkedIn"><input name="linkedinUrl" type="url" className={inputCls} placeholder="https://linkedin.com/in/…" /></Field>
            </Row>
            <Field label="Resume">
              <label className="flex items-center gap-3 rounded-xl border border-dashed border-foreground/20 bg-secondary px-4 py-3 cursor-pointer hover:border-violet-500/40 transition-colors">
                <input
                  type="file" accept=".pdf,.doc,.docx,.rtf" className="hidden"
                  onChange={e => setResumeFile(e.target.files?.[0] ?? null)}
                />
                {resumeFile ? <FileText className="h-4 w-4 text-violet-400 shrink-0" /> : <Upload className="h-4 w-4 text-muted-foreground shrink-0" />}
                <span className="text-sm text-muted-foreground truncate">
                  {resumeFile ? resumeFile.name : 'Click to upload PDF, DOC, DOCX or RTF (max 15MB)'}
                </span>
              </label>
            </Field>
          </Section>

          <Section title="Tell us more">
            <Field label="Skills"><input name="skills" className={inputCls} placeholder="Photoshop, After Effects, Copywriting…" /></Field>
            <Field label="Cover Letter"><textarea name="coverLetter" rows={3} className={inputCls} placeholder="Optional" /></Field>
            <Field label="Why do you want to join Cirqle?"><textarea name="whyJoin" rows={4} className={inputCls} /></Field>
          </Section>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-sm px-3.5 py-2.5">{error}</div>
          )}

          <button
            type="submit" disabled={isPending}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium py-3 transition-colors disabled:opacity-60"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? 'Uploading resume…' : isPending ? 'Submitting…' : 'Submit Application'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <FormField>
      <FormLabel className={labelCls}>{label}{required && <span className="text-destructive"> *</span>}</FormLabel>
      {React.isValidElement(children) ? <FormControl>{children}</FormControl> : children}
    </FormField>
  )
}
