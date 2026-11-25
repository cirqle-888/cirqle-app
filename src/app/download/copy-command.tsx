'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/** A Terminal command with a copy button — typed by hand, one wrong character breaks it. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* the command is on screen to select by hand */ }
  }
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 p-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
