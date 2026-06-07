'use client'

import { useEffect, useState } from 'react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Mail, Send, Loader2, AlertTriangle, FileText, CheckCircle } from 'lucide-react'
import { getPayslipPreview, sendPayslip } from '@/lib/payslip/actions'

interface Props {
  employeeId: string
  month: number
  year: number
  monthLabel: string            // e.g. "May 2026"
  onClose: () => void
  onSent?: (to: string) => void
}

/** Preview → edit → send a single payslip. */
export function PayslipModal({ employeeId, month, year, monthLabel, onClose, onSent }: Props) {
  const [loading, setLoading]   = useState(true)
  const [loadErr, setLoadErr]   = useState<string | null>(null)
  const [html, setHtml]         = useState('')
  const [emailConfigured, setEmailConfigured] = useState(true)
  const [empName, setEmpName]   = useState('')
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject]   = useState('')
  const [note, setNote]         = useState('')
  const [sending, setSending]   = useState(false)
  const [sentTo, setSentTo]     = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setLoadErr(null)
      const res = await getPayslipPreview(employeeId, month, year)
      if (!alive) return
      if (!res.ok || !res.data) { setLoadErr(res.error || 'Failed to load payslip'); setLoading(false); return }
      setHtml(res.data.html)
      setSubject(res.data.subject)
      setRecipient(res.data.recipient)
      setEmpName(res.data.data.employee.name)
      setEmailConfigured(res.data.emailConfigured)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [employeeId, month, year])

  async function handleSend() {
    if (!recipient.trim()) return
    setSending(true)
    const res = await sendPayslip({
      employeeId, month, year,
      toOverride: recipient.trim(),
      subjectOverride: subject.trim(),
      note: note.trim() || undefined,
    })
    setSending(false)
    if (res.ok && res.data) {
      setSentTo(res.data.to)
      onSent?.(res.data.to)
      setTimeout(onClose, 1400)
    } else {
      setLoadErr(res.error || 'Send failed')
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Mail className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-sm">Send Payslip</p>
              <p className="text-xs text-muted-foreground">{empName ? `${empName} · ` : ''}{monthLabel}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Building payslip…
          </div>
        ) : loadErr && !html ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <AlertTriangle className="w-8 h-8 text-red-400 mb-3" />
            <p className="text-sm text-red-400">{loadErr}</p>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row min-h-0 flex-1">
            {/* Preview */}
            <div className="md:w-1/2 border-b md:border-b-0 md:border-r border-border bg-[#0b1120] p-3 overflow-auto">
              <iframe
                title="Payslip preview"
                srcDoc={html}
                sandbox=""
                className="w-full rounded-lg border border-border bg-white"
                style={{ height: 520 }}
              />
            </div>

            {/* Controls */}
            <div className="md:w-1/2 p-5 flex flex-col gap-4 overflow-auto">
              {!emailConfigured && (
                <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3.5 py-3">
                  <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-amber-300">Email not configured</p>
                    <p className="text-xs text-amber-400/80 mt-0.5">Set <code>RESEND_API_KEY</code> and verify your sending domain to enable sending.</p>
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-muted-foreground">Recipient</label>
                <input
                  type="email" value={recipient} onChange={e => setRecipient(e.target.value)}
                  placeholder="employee@email.com"
                  className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/50"
                />
                {!recipient && <p className="text-[11px] text-red-400 mt-1">No email on file — enter one to send.</p>}
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Subject</label>
                <input
                  type="text" value={subject} onChange={e => setSubject(e.target.value)}
                  className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/50"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Personal note <span className="text-muted-foreground/60">(optional)</span></label>
                <textarea
                  value={note} onChange={e => setNote(e.target.value)} rows={3}
                  placeholder="Add a short message shown at the top of the email…"
                  className="mt-1 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-primary/50"
                />
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="w-3.5 h-3.5" /> A branded PDF payslip is attached automatically.
              </div>

              {loadErr && html && (
                <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-400">{loadErr}</p>
                </div>
              )}

              <div className="mt-auto flex gap-3 pt-2">
                <button onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !recipient.trim() || !emailConfigured || !!sentTo}
                  className="flex-1 bg-primary text-primary-foreground text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {sentTo ? <><CheckCircle className="w-4 h-4" /> Sent</>
                    : sending ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                    : <><Send className="w-4 h-4" /> Send Payslip</>}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalOverlay>
  )
}
