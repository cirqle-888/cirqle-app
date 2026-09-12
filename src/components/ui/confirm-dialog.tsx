'use client'

import React, { useState } from 'react'

export interface ConfirmModalProps {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact text. For actions that destroy data irreversibly — where the cost of
   * a mis-click is not a corrected mistake but a lost record — and especially
   * where the destructive button sits next to a benign one.
   *
   * Optional, so every existing caller keeps its single-click behaviour.
   */
  requireTypedText?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title, body, confirmLabel, danger, requireTypedText, onConfirm, onCancel,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState('')
  // Trailing whitespace from a paste or an autocorrected space should not be
  // the thing standing between someone and a deliberate action.
  const unlocked = !requireTypedText || typed.trim() === requireTypedText.trim()

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="bg-background rounded-xl shadow-2xl p-6 max-w-sm w-full animate-in zoom-in-95">
        <h3 className="font-semibold text-sm mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed">{body}</p>

        {requireTypedText && (
          <div className="mb-5">
            <label className="block text-xs text-muted-foreground mb-1.5">
              Type <span className="font-semibold text-foreground">{requireTypedText}</span> to confirm
            </label>
            <input
              autoFocus
              value={typed}
              onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && unlocked) onConfirm() }}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
              placeholder={requireTypedText}
            />
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm font-medium hover:bg-muted rounded-md transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={!unlocked}
            className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-primary hover:bg-primary/90'
            }`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
