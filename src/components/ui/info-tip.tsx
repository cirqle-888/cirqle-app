'use client'

import { useState } from 'react'
import { Info } from 'lucide-react'

interface Props {
  text: string
  direction?: 'up' | 'down'
}

export default function InfoTip({ text, direction = 'up' }: Props) {
  const [show, setShow] = useState(false)

  return (
    <span className="relative inline-flex items-center ml-1.5">
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        className="text-muted-foreground hover:text-primary transition-colors"
        tabIndex={-1}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {show && (
        <div className={`absolute left-1/2 -translate-x-1/2 z-50 w-56 bg-popover border border-border rounded-lg px-3 py-2 shadow-xl text-xs text-muted-foreground leading-relaxed pointer-events-none ${
          direction === 'down' ? 'top-full mt-2' : 'bottom-full mb-2'
        }`}>
          {text}
          <div className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${
            direction === 'down' ? 'bottom-full border-b-border' : 'top-full border-t-border'
          }`} />
        </div>
      )}
    </span>
  )
}
