'use client'

import { useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import { copyToClipboard } from '@/lib/clipboard'
import { aiPromptForBrief, type BriefForPrompt } from '@/lib/content-brief-prompt'

/**
 * "Copy AI prompt": the post's ready-to-paste prompt (from the notes, or
 * built from the brief) for Firefly, ChatGPT, Gemini or a video tool.
 */
export default function CopyAiPromptButton({ brief, className = '' }: { brief: BriefForPrompt; className?: string }) {
  const [copied, setCopied] = useState(false)
  const { text, fromNotes } = aiPromptForBrief(brief)
  if (!text.trim()) return null
  async function copy() {
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <button type="button" onClick={() => void copy()}
      title={fromNotes ? 'Copy the AI prompt written in the notes' : 'No AI prompt in the notes: copy one built from this brief'}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-500/30 bg-violet-500/10 text-[11px] font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-500/15 transition-colors ${className}`}>
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Sparkles className="w-3 h-3" />}
      {copied ? 'Copied' : fromNotes ? 'Copy AI prompt' : 'Copy as AI prompt'}
    </button>
  )
}
