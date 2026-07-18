import { useEffect, useRef } from 'react'

export interface ShortcutHandlers {
  onSelectAll?: () => void
  onClearSelection?: () => void
  onDeleteSelected?: () => void
  onDuplicateSelected?: () => void
  onBulkWeight?: () => void
  onBulkMove?: () => void
  onBulkPrice?: () => void
  onBulkBadge?: () => void
  onAiCapture?: () => void
  onFocusSearch?: () => void
  onSave?: () => void
  onUndo?: () => void
  onRedo?: () => void
  onEscape?: () => void
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  // Callers pass a fresh object literal every render, so depending on it
  // directly tore down and re-attached the window listener on every keystroke.
  // The ref keeps the listener attached once while still calling the latest
  // handlers.
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const handlers = handlersRef.current
      // Ignore shortcuts if typing inside an input/textarea (except Escape)
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (e.key === 'Escape') {
        if (handlers.onEscape) {
          handlers.onEscape()
          e.preventDefault()
        }
        return
      }

      if (isInput) return

      const ctrlOrCmd = e.ctrlKey || e.metaKey
      const shift = e.shiftKey

      if (ctrlOrCmd && !shift && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        handlers.onSelectAll?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        handlers.onClearSelection?.()
      } else if (e.key === 'Delete' || (ctrlOrCmd && e.key === 'Backspace')) {
        // Bare Backspace used to land here. Outside an input it is also the
        // browser's "go back" gesture, so a stray press could pop the
        // delete-confirm dialog on the way to unloading the page — and this
        // editor has no autosave. Delete is unambiguous; Backspace now needs a
        // modifier.
        e.preventDefault()
        handlers.onDeleteSelected?.()
      } else if (ctrlOrCmd && !shift && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        handlers.onDuplicateSelected?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        handlers.onBulkWeight?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        handlers.onBulkMove?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        handlers.onBulkPrice?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        handlers.onBulkBadge?.()
      } else if (ctrlOrCmd && shift && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        handlers.onAiCapture?.()
      } else if (ctrlOrCmd && !shift && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        handlers.onFocusSearch?.()
      } else if (ctrlOrCmd && !shift && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handlers.onSave?.()
      } else if (ctrlOrCmd && !shift && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        handlers.onUndo?.()
      } else if ((ctrlOrCmd && !shift && e.key.toLowerCase() === 'y') || (ctrlOrCmd && shift && e.key.toLowerCase() === 'z')) {
        e.preventDefault()
        handlers.onRedo?.()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
