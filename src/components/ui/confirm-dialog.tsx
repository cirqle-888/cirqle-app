import React from 'react'

export interface ConfirmModalProps {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="bg-background rounded-xl shadow-2xl p-6 max-w-sm w-full animate-in zoom-in-95">
        <h3 className="font-semibold text-sm mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed">{body}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm font-medium hover:bg-muted rounded-md transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors ${
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
