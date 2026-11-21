'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Sparkles } from 'lucide-react'
import { usePermissions } from '@/contexts/permission-context'
import { copyToClipboard } from '@/lib/clipboard'
import { copyImage } from '@/lib/copy-image'
import { aiPromptForBrief, postPromptWithCard, type BriefForPrompt } from '@/lib/content-brief-prompt'
import { renderClientCard } from '@/lib/prompt-studio/render'
import { loadClientCard } from '@/app/(dashboard)/dashboard/prompt-studio/actions'

/** How long a loaded card is reused before it is fetched again (an edit in Prompt Studio shows up after this). */
const FRESH_MS = 60_000
interface LoadedCard { text: string; logo: string }
const NO_CARD: LoadedCard = { text: '', logo: '' }
/** clientId → the card as printed in prompts ('' = no card) and its logo link, shared by every button on the page. */
const cards = new Map<string, { at: number; card: Promise<LoadedCard> }>()

function loadCard(clientId: string): Promise<LoadedCard> {
  const hit = cards.get(clientId)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.card
  const card = loadClientCard(clientId).then(
    (r): LoadedCard => (r.ok ? { text: renderClientCard(r.data?.card ?? null), logo: (r.data?.card?.logo ?? '').trim() } : NO_CARD),
    () => NO_CARD,
  )
  cards.set(clientId, { at: Date.now(), card })
  return card
}

/**
 * "Copy AI prompt": everything a fresh ChatGPT, Gemini or Claude chat needs
 * to make this post's visual (the client's card, the post's details and the
 * prompt). "Prompt only" copies just the prompt, for Firefly or another
 * image tool with a small prompt box.
 *
 * The card is loaded once the button shows, so the click copies at once.
 * People without Prompt Studio, and clients with no card yet, get the prompt
 * alone.
 */
export default function CopyAiPromptButton({ brief, clientId, className = '' }: {
  brief: BriefForPrompt
  /** The post's client: its Prompt Studio card goes above the prompt. */
  clientId?: string | null
  className?: string
}) {
  const { can } = usePermissions()
  const useCard = !!clientId && can('prompt_studio.view')
  const [card, setCard] = useState<({ id: string } & LoadedCard) | null>(null)
  const [copied, setCopied] = useState<'full' | 'prompt' | 'logo' | 'logo-link' | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)

  useEffect(() => {
    if (!useCard || !clientId) return
    let live = true
    void loadCard(clientId).then(c => { if (live) setCard({ id: clientId, ...c }) })
    return () => { live = false }
  }, [useCard, clientId])

  const { text: prompt, fromNotes } = aiPromptForBrief(brief)
  if (!prompt.trim()) return null
  const cardFor = useCard && card?.id === clientId ? card.text : null
  const logo = useCard && card?.id === clientId ? card.logo : ''
  const logoIsLink = /^https?:\/\/\S+$/i.test(logo)
  const hasCard = !!cardFor
  const noCard = cardFor === ''

  async function copy(kind: 'full' | 'prompt') {
    let text = prompt
    if (kind === 'full' && useCard && clientId) text = postPromptWithCard(cardFor ?? (await loadCard(clientId)).text, brief)
    if (!(await copyToClipboard(text))) return
    setCopied(kind)
    setTimeout(() => setCopied(null), 1600)
  }

  /** The logo picture on the clipboard, to paste into the AI chat after the prompt. If the link cannot be read as a picture, the link is copied instead. */
  async function copyLogo() {
    setLogoFailed(false)
    if (await copyImage(logo)) { setCopied('logo'); setTimeout(() => setCopied(null), 1600); return }
    if (await copyToClipboard(logo)) { setCopied('logo-link'); setTimeout(() => setCopied(null), 1600); return }
    setLogoFailed(true)
  }

  const pill = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-500/30 bg-violet-500/10 text-[11px] font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-500/15 transition-colors'
  const label = fromNotes ? 'Copy AI prompt' : 'Copy as AI prompt'
  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${className}`}>
      {noCard && clientId && (
        <Link href={`/dashboard/prompt-studio?client=${clientId}&tab=cards`}
          title="This client has no Client Card yet, so the copy has the prompt only. Add the card so every prompt carries the brand."
          className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline">
          No client card: add one
        </Link>
      )}
      {logoIsLink && (
        <button type="button" onClick={() => void copyLogo()}
          title="Copies the logo picture: paste it into the AI chat after the prompt. If this link cannot be read as a picture, the link is copied instead."
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
          {copied === 'logo' ? 'Logo copied' : copied === 'logo-link' ? 'Logo link copied' : logoFailed ? 'Could not copy' : 'Copy logo'}
        </button>
      )}
      {hasCard && !logo && (
        <Link href={`/dashboard/prompt-studio?client=${clientId}&tab=cards`}
          title="The card has no logo yet. Add the logo link or upload the file on the card."
          className="text-[10px] text-amber-600 dark:text-amber-400 hover:underline">
          No logo: add one
        </Link>
      )}
      {hasCard && (
        <button type="button" onClick={() => void copy('prompt')}
          title="Just the prompt, for Firefly or another image tool with a small prompt box"
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
          {copied === 'prompt' ? 'Copied' : 'Prompt only'}
        </button>
      )}
      <button type="button" onClick={() => void copy('full')}
        title={hasCard
          ? 'Copies the client card, this post\'s details and the AI prompt: paste it into a new ChatGPT, Gemini or Claude chat'
          : fromNotes ? 'Copy the AI prompt written in the notes' : 'No AI prompt in the notes: copy one built from this brief'}
        className={pill}>
        {copied === 'full' ? <Check className="w-3 h-3 text-emerald-500" /> : <Sparkles className="w-3 h-3" />}
        {copied === 'full' ? 'Copied' : hasCard ? `${label} + card` : label}
      </button>
    </span>
  )
}
