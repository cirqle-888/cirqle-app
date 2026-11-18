'use client'

/**
 * "Copy for AI" — one click on a client's page copies everything an outside
 * AI (Codex, Gemini, ChatGPT, Claude) needs to plan that client's social
 * media: the Client Card, alone or with one planning job under it.
 *
 * The card is fetched the first time the menu opens, so a page that shows this
 * button loads nothing extra. People without Prompt Studio see no button.
 *
 * The panel is portalled to <body> for the reason OverflowMenu is: header rows
 * and <main> clip an absolutely-positioned panel.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { copyToClipboard } from '@/lib/clipboard'
import { AI_JOBS, buildAiBrief, planMonthLabel, socialGaps, type AiJob } from '@/lib/prompt-studio/ai-brief'
import { COLOR_USE_OPTIONS, swatches } from '@/lib/prompt-studio/colors'
import { isDirectImageLink } from '@/lib/prompt-studio/render'
import type { ClientCard } from '@/lib/prompt-studio/types'
import { loadClientCard } from '@/app/(dashboard)/dashboard/prompt-studio/actions'

const PANEL_W = 288
const MARGIN = 8
const isLink = (v: string | undefined) => /^https?:\/\/\S+$/i.test((v ?? '').trim())

/**
 * Put the logo itself on the clipboard, to paste into the AI tool after the
 * prompt. Clipboards take PNG, so anything else is redrawn as one. Works for
 * logos uploaded here and any image link that allows it; a page link (a Drive
 * preview, say) cannot be read, and the caller says so.
 */
async function copyImage(url: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return false
    let blob = await res.blob()
    if (!blob.type.startsWith('image/')) return false
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      const png = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/png'))
      if (!png) return false
      blob = png
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

export function CopyForAi({
  clientId,
  card: given,
  onEditCard,
  align = 'right',
  compact = false,
  className = '',
}: {
  clientId: string
  /** Pass the card when the page already has it (Prompt Studio); otherwise it is fetched on open. */
  card?: ClientCard | null
  /** Open the card editor in place, instead of following the link to Prompt Studio. */
  onEditCard?: () => void
  align?: 'left' | 'right'
  /** Short label, for a header row that is already full. */
  compact?: boolean
  className?: string
}) {
  const { can } = usePermissions()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [fetched, setFetched] = useState<{ id: string; card: ClientCard | null } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<AiJob | 'logo' | 'logo-link' | null>(null)
  const [options, setOptions] = useState(false)
  const [month, setMonth] = useState('')
  const [mode, setMode] = useState<'Regular' | 'Random'>('Regular')
  const [colorUse, setColorUse] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const loaded = given !== undefined || fetched?.id === clientId
  const card = given !== undefined ? given : fetched?.id === clientId ? fetched.card : null

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const left = align === 'right' ? r.right - PANEL_W : r.left
    setPos({ top: r.bottom + 6, left: Math.max(MARGIN, Math.min(left, window.innerWidth - PANEL_W - MARGIN)) })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // Fetch the card the first time the menu opens for this client.
  useEffect(() => {
    if (!open || given !== undefined || fetched?.id === clientId) return
    let live = true
    loadClientCard(clientId).then(
      r => {
        if (!live) return
        if (r.ok) { setError(''); setFetched({ id: clientId, card: r.data?.card ?? null }) }
        else setError(r.error || 'Could not load the card.')
      },
      () => { if (live) setError('Could not load the card.') },
    )
    return () => { live = false }
  }, [open, given, fetched, clientId])

  if (!clientId || !can('prompt_studio.view')) return null

  const cardHref = `/dashboard/prompt-studio?client=${clientId}&tab=cards`
  const gaps = card ? socialGaps(card) : []
  const shownColours = card ? swatches(card.colors, colorUse || card.colorUse) : []

  async function copy(job: AiJob) {
    const text = buildAiBrief(card, job, { month: month.trim() || planMonthLabel(new Date()), mode, colorUse: colorUse || undefined })
    if (!text || !(await copyToClipboard(text))) { setError('Could not copy. Try again.'); return }
    setError('')
    setCopied(job)
    window.setTimeout(() => { setCopied(null); setOpen(false) }, 900)
  }

  async function copyLogoLink() {
    if (!(await copyToClipboard((card?.logo ?? '').trim()))) {
      setError('Could not copy the link. Use "Open logo" and copy the address there.')
      return
    }
    setError('')
    setCopied('logo-link')
    window.setTimeout(() => setCopied(null), 1500)
  }

  async function copyLogo() {
    if (!(await copyImage((card?.logo ?? '').trim()))) {
      setError('Could not copy this logo. Use "Open logo" and copy it there, or upload the logo on the card.')
      return
    }
    setError('')
    setCopied('logo')
    window.setTimeout(() => setCopied(null), 1500)
  }

  const editCard = onEditCard
    ? <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setOpen(false); onEditCard() }}>{card ? 'Edit card' : 'Add card'}</button>
    : <Link href={cardHref} className="font-medium text-primary hover:underline">{card ? 'Edit card' : 'Add card'}</Link>

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Copy for AI"
        title="Copy this client's details for Codex, Gemini, ChatGPT or Claude"
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:border-primary/40 ${className}`}
      >
        <Sparkles className="h-4 w-4 text-violet-500" /> {compact ? 'AI' : 'Copy for AI'} <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label="Copy for AI"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W }}
          className="z-[120] rounded-xl border border-border bg-card p-1.5 text-sm shadow-lg"
        >
          {error && <p className="px-2.5 py-2 text-red-500">{error}</p>}
          {!loaded && !error && <p className="px-2.5 py-2 text-muted-foreground">Loading…</p>}
          {loaded && !card && (
            <p className="px-2.5 py-2 text-muted-foreground">No Client Card yet. {editCard}</p>
          )}
          {loaded && card && (
            <>
              {AI_JOBS.map(j => (
                <button
                  key={j.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void copy(j.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary ${j.id === 'details' ? 'mt-1 border-t border-border pt-2.5 text-muted-foreground' : ''}`}
                >
                  <span className="flex-1 truncate">{j.label}{j.id === 'calendar' ? ` · ${mode}` : ''}</span>
                  {copied === j.id && <span className="inline-flex items-center gap-1 text-xs text-green-600"><Check className="h-3.5 w-3.5" /> Copied</span>}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setOptions(o => !o)}
                aria-expanded={options}
                className="mt-1 flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
              >
                Options <ChevronDown className={`h-3.5 w-3.5 transition-transform ${options ? 'rotate-180' : ''}`} />
              </button>
              {options && (
                <div className="space-y-2 px-2.5 pb-2 pt-1">
                  <label className="block text-xs text-muted-foreground">
                    Calendar month
                    <input
                      className="field mt-1 w-full"
                      value={month}
                      placeholder={planMonthLabel(new Date())}
                      onChange={e => setMonth(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-1" role="group" aria-label="Plan type">
                    {(['Regular', 'Random'] as const).map(m => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={mode === m}
                        onClick={() => setMode(m)}
                        className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${mode === m ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <label className="block text-xs text-muted-foreground">
                    Colours
                    <select className="field mt-1 w-full" value={colorUse} onChange={e => setColorUse(e.target.value)}>
                      <option value="">{card.colorUse ? `As on the card (${card.colorUse})` : 'As on the card (no rule)'}</option>
                      {COLOR_USE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </label>
                  {shownColours.length > 0 && (
                    <div className="flex flex-wrap gap-1" aria-label="Colours this copy will use">
                      {shownColours.map(c => (
                        <span key={c} title={c} className="h-5 w-5 rounded border border-border" style={{ background: c }} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-1 space-y-1 border-t border-border px-2.5 pb-1 pt-2 text-xs">
                {gaps.length > 0 && (
                  <p className="text-amber-700 dark:text-amber-300">Card is missing: {gaps.join(', ')}</p>
                )}
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  {editCard}
                  {isLink(card.logo) && (
                    <a href={card.logo.trim()} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Open logo</a>
                  )}
                  {isDirectImageLink(card.logo) && (
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => void copyLogoLink()}>
                      {copied === 'logo-link' ? 'Link copied' : 'Copy logo link'}
                    </button>
                  )}
                  {isLink(card.logo) && (
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => void copyLogo()}>
                      {copied === 'logo' ? 'Logo copied' : 'Copy logo image'}
                    </button>
                  )}
                </p>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
