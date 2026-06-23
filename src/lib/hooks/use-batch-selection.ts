'use client'

import { useState, useCallback } from 'react'

/**
 * Shared multi-select state for batch-action toolbars (Tasks, Invoices,
 * Requests, ...). Generalizes the pattern Tasks already had inline
 * (selectedTasks/bulkMode) so every module follows the same
 * select → action bar → execute flow instead of reinventing it per page.
 */
export function useBatchSelection<T extends string = string>() {
  const [mode, setMode] = useState(false)
  const [selected, setSelected] = useState<Set<T>>(new Set())

  const toggle = useCallback((id: T) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((ids: T[]) => {
    setSelected(prev => prev.size === ids.length && ids.every(id => prev.has(id)) ? new Set() : new Set(ids))
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    setMode(false)
  }, [])

  const isSelected = useCallback((id: T) => selected.has(id), [selected])

  return { mode, setMode, selected, toggle, toggleAll, clear, isSelected, count: selected.size }
}
