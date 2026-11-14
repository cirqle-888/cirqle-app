'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, RefreshCw, Sparkles } from 'lucide-react'
import { askWhatsAppChats, markPendingDone, refreshWhatsAppReports } from './actions'

const TABS = [
  { key: 'chats', label: 'Chats', href: '/dashboard/requests/whatsapp' },
  { key: 'pending', label: 'Pending', href: '/dashboard/requests/whatsapp/pending' },
  { key: 'report', label: 'Daily report', href: '/dashboard/requests/whatsapp/report' },
] as const

export function WhatsAppTabs({ active }: { active: (typeof TABS)[number]['key'] }) {
  return (
    <nav aria-label="WhatsApp sections" className="flex gap-1 border-b border-border">
      {TABS.map(t => (
        <Link key={t.key} href={t.href} aria-current={t.key === active ? 'page' : undefined}
          className={`px-3 py-2 text-sm -mb-px border-b-2 ${t.key === active ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** "Update now": reads the new messages without waiting for the evening run. */
export function RefreshReportsButton() {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy}
        onClick={() => start(async () => {
          setNote(null)
          const res = await refreshWhatsAppReports()
          setNote({ ok: res.ok, text: res.ok ? res.message || 'Updated.' : res.error || 'Could not update.' })
          if (res.ok) router.refresh()
        })}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium border border-border bg-card hover:bg-secondary disabled:opacity-50">
        <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> {busy ? 'Reading the chats…' : 'Update now'}
      </button>
      {note && <span role="status" className={`text-xs ${note.ok ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'}`}>{note.text}</span>}
    </span>
  )
}

export function DoneButton({ chatId, itemId, label }: { chatId: string; itemId: string; label: string }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState('')
  return (
    <span className="inline-flex items-center gap-2 shrink-0">
      {error && <span role="alert" className="text-[11px] text-red-600 dark:text-red-400">{error}</span>}
      <button type="button" disabled={busy} aria-label={`Mark done: ${label}`}
        onClick={() => start(async () => {
          const res = await markPendingDone(chatId, itemId)
          if (res.ok) router.refresh(); else setError(res.error || 'Could not save.')
        })}
        className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] border border-border bg-secondary hover:text-foreground text-muted-foreground disabled:opacity-50">
        <Check className="w-3 h-3" /> {busy ? 'Saving…' : 'Done'}
      </button>
    </span>
  )
}

const EXAMPLES = ['What is pending on our side today?', 'Which clients are waiting longest?', 'What are we waiting for from clients?']

/** Ask a question about the chats. Answers come only from chats shared with the asker. */
export function AskBox() {
  const [question, setQuestion] = useState('')
  const [busy, start] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; text: string; asked: string } | null>(null)

  function ask(q: string) {
    const asked = q.trim()
    if (!asked || busy) return
    start(async () => {
      const res = await askWhatsAppChats(asked)
      setResult({ ok: res.ok, text: res.ok ? res.answer || '' : res.error || 'Could not answer.', asked })
    })
  }

  return (
    <section aria-label="Ask about the chats" className="border border-border rounded-xl bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold">Ask about a client or what is pending</h2>
      </div>
      <form onSubmit={e => { e.preventDefault(); ask(question) }} className="flex flex-wrap gap-2">
        <input
          aria-label="Your question"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="e.g. What is the current situation with Sea Star?"
          className="flex-1 min-w-[220px] bg-secondary border border-border rounded-lg px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy || question.trim().length < 3}
          className="gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
          {busy ? 'Thinking…' : 'Ask'}
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map(x => (
          <button key={x} type="button" disabled={busy} onClick={() => { setQuestion(x); ask(x) }}
            className="text-[11px] px-2 py-1 rounded-full border border-border bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50">
            {x}
          </button>
        ))}
      </div>
      {result && (
        <div role="status" className={`rounded-lg border px-3 py-2.5 text-sm ${result.ok ? 'border-border bg-secondary/50' : 'border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-400'}`}>
          <p className="text-[11px] text-muted-foreground mb-1">{result.asked}</p>
          <p className="whitespace-pre-wrap break-words">{result.text}</p>
          {result.ok && <p className="mt-2 text-[10px] text-muted-foreground">Written by AI from the chats you can see. Check the chat before acting on it.</p>}
        </div>
      )}
    </section>
  )
}
