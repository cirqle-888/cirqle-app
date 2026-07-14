'use client'

import { useState, useRef, useMemo } from 'react'
import { X } from 'lucide-react'

interface Props {
  /** Existing tag names, for autocomplete. */
  availableTags: string[]
  /** Currently selected tag names for this entry. */
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
}

/**
 * Chip-based multi-select tag input with inline "create new" — no DB round
 * trip needed here; tag creation-if-missing happens server-side when the
 * entry is saved (see cashbook/actions.ts resolveOrCreateTagIds).
 */
export default function TagPicker({ availableTags, value, onChange, placeholder = 'Add tag…' }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    const selected = new Set(value.map(v => v.toLowerCase()))
    return availableTags
      .filter(t => !selected.has(t.toLowerCase()))
      .filter(t => !q || t.toLowerCase().includes(q))
      .slice(0, 8)
  }, [availableTags, value, query])

  const exactMatchExists = availableTags.some(t => t.toLowerCase() === query.trim().toLowerCase())

  function commit(raw: string) {
    const name = raw.trim()
    if (!name) return
    // Reuse the canonical casing of an existing tag (case-insensitive) so
    // "Photoshop" typed after "photoshop" doesn't fork into a second tag.
    const existing = availableTags.find(t => t.toLowerCase() === name.toLowerCase())
    const canonical = existing || name
    if (!value.some(v => v.toLowerCase() === canonical.toLowerCase())) {
      onChange([...value, canonical])
    }
    setQuery('')
  }

  function remove(tag: string) {
    onChange(value.filter(v => v !== tag))
  }

  return (
    <div className="relative">
      <div
        className="flex flex-wrap gap-1.5 items-center bg-secondary border border-border rounded-lg px-2 py-1.5 min-h-[38px] cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 bg-primary/15 text-primary text-xs font-medium px-2 py-1 rounded-md">
            {tag}
            <button type="button" onClick={() => remove(tag)} className="hover:text-primary/70">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(query) }
            else if (e.key === 'Backspace' && !query && value.length > 0) {
              onChange(value.slice(0, -1))
            }
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[80px] bg-transparent text-xs focus:outline-none py-0.5"
        />
      </div>
      {open && (query.trim() || suggestions.length > 0) && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto">
          {suggestions.map(s => (
            <button
              key={s}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commit(s)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-secondary"
            >
              {s}
            </button>
          ))}
          {query.trim() && !exactMatchExists && (
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commit(query)}
              className="w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-secondary font-medium"
            >
              + Create &quot;{query.trim()}&quot;
            </button>
          )}
        </div>
      )}
    </div>
  )
}
