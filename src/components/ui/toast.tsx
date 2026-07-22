'use client'

import { useEffect, useState, useRef } from 'react'
import { CheckCircle, AlertCircle, Info, X, RotateCcw } from 'lucide-react'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastMessage {
  id: string
  type: ToastType
  title: string
  body?: string
  duration?: number   // ms, default 3000
  action?: {          // optional undo / action button
    label: string
    onClick: () => void
  }
}

interface ToastProps {
  toast: ToastMessage
  onDismiss: (id: string) => void
}

function Toast({ toast, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false)
  // Progress bar for duration (only shown when action exists — helps user see the undo window)
  const [progress, setProgress] = useState(100)
  const startRef  = useRef<number>(Date.now())
  const rafRef    = useRef<number | undefined>(undefined)
  const duration  = toast.duration ?? 3000

  // Mount animation
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(t)
  }, [])

  // Auto-dismiss + progress bar
  useEffect(() => {
    startRef.current = Date.now()

    if (toast.action) {
      // Animate progress bar
      const tick = () => {
        const elapsed = Date.now() - startRef.current
        const pct = Math.max(0, 100 - (elapsed / duration) * 100)
        setProgress(pct)
        if (pct > 0) rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const t = setTimeout(() => {
      setVisible(false)
      setTimeout(() => onDismiss(toast.id), 300)
    }, duration)

    return () => {
      clearTimeout(t)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [toast.id, toast.duration, toast.action, duration, onDismiss])

  function handleAction() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    toast.action?.onClick()
    setVisible(false)
    setTimeout(() => onDismiss(toast.id), 300)
  }

  const icons = {
    success: <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />,
    error:   <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />,
    info:    <Info className="w-4 h-4 text-blue-400 shrink-0" />,
  }

  const borders = {
    success: 'border-green-500/30',
    error:   'border-red-500/30',
    info:    'border-blue-500/30',
  }

  const progressColors = {
    success: 'bg-green-500/50',
    error:   'bg-red-500/50',
    info:    'bg-blue-500/50',
  }

  return (
    <div className={`relative flex items-start gap-3 bg-card border ${borders[toast.type]} rounded-xl px-4 py-3 shadow-2xl shadow-black/40 max-w-sm w-full overflow-hidden
      transition-all duration-300 ease-out
      ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

      {/* Progress bar (shows undo window) */}
      {toast.action && (
        <div className="absolute bottom-0 left-0 h-0.5 bg-foreground/[0.04] w-full">
          <div
            className={`h-full ${progressColors[toast.type]} transition-none`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {icons[toast.type]}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground leading-tight">{toast.title}</p>
        {toast.body && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{toast.body}</p>}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {toast.action && (
          <button
            type="button"
            onClick={handleAction}
            className="flex items-center gap-1 text-xs font-semibold text-violet-400 hover:text-violet-700 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/20 rounded-lg px-2 py-1 transition-colors">
            <RotateCcw className="w-3 h-3" />
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => { setVisible(false); setTimeout(() => onDismiss(toast.id), 300) }}
          className="text-muted-foreground/40 hover:text-foreground transition-colors mt-0.5">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

// ── Toast container ───────────────────────────────────────────────────────────
interface ContainerProps { toasts: ToastMessage[]; onDismiss: (id: string) => void }

export function ToastContainer({ toasts, onDismiss }: ContainerProps) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <Toast toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  )
}

// ── Hook ─────────────────────────────────────────────────────────────────────
let toastId = 0

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  function show(type: ToastType, title: string, body?: string, duration = 3000, action?: ToastMessage['action']) {
    const id = String(++toastId)
    setToasts(prev => [...prev, { id, type, title, body, duration, action }])
    return id
  }

  function dismiss(id: string) {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  return {
    toasts,
    dismiss,
    success:    (title: string, body?: string, duration?: number, action?: ToastMessage['action']) => show('success', title, body, duration, action),
    error:      (title: string, body?: string, duration?: number) => show('error',   title, body, duration),
    info:       (title: string, body?: string, duration?: number, action?: ToastMessage['action']) => show('info',    title, body, duration, action),
    toastError: (title: string, body?: string) => show('error', title, body),
  }
}
