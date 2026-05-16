'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { birthdayDismissKey } from '@/lib/utils/birthday'

interface Props {
  employeeId: string
  name?: string | null
  cqid: string
}

/**
 * Fully self-contained birthday celebration:
 *  - Confetti burst on mount (CSS-only, no external lib)
 *  - Dismissible banner persisted to localStorage for the day
 */
export function BirthdayCelebration({ employeeId, name, cqid }: Props) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = birthdayDismissKey(employeeId)
    if (window.localStorage.getItem(key) === 'dismissed') return
    setShow(true)
  }, [employeeId])

  function dismiss() {
    setShow(false)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(birthdayDismissKey(employeeId), 'dismissed')
    }
  }

  if (!show) return null

  return (
    <>
      {/* Confetti — pure CSS falling dots */}
      <div className="pointer-events-none fixed inset-0 z-[999] overflow-hidden">
        {Array.from({ length: 60 }).map((_, i) => (
          <span
            key={i}
            className="absolute top-[-10vh] block w-2 h-2 rounded-sm animate-bday-fall"
            style={{
              left: `${(i * 37) % 100}%`,
              backgroundColor: BDAY_COLORS[i % BDAY_COLORS.length],
              animationDelay: `${(i % 10) * 0.2}s`,
              animationDuration: `${4 + (i % 5)}s`,
              transform: `rotate(${(i * 13) % 360}deg)`,
            }}
          />
        ))}
      </div>

      {/* Banner */}
      <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[1000] max-w-md w-[calc(100%-2rem)]">
        <div className="relative bg-gradient-to-r from-pink-500/20 via-purple-500/20 to-orange-500/20 border border-pink-400/40 backdrop-blur-md rounded-2xl px-5 py-4 shadow-2xl shadow-purple-500/30">
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="absolute top-2 right-2 p-1 rounded-md hover:bg-white/10 transition-colors text-white/60 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-3">
            <div className="text-3xl">🎂</div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-white">
                Happy Birthday, {name || cqid}!
              </div>
              <div className="text-xs text-white/80">
                Wishing you an incredible year ahead from the whole Cirqle team 🎉
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes bday-fall {
          0%   { transform: translateY(0)        rotate(0deg);   opacity: 1; }
          100% { transform: translateY(110vh)    rotate(720deg); opacity: 0; }
        }
        .animate-bday-fall { animation: bday-fall linear infinite; }
      `}</style>
    </>
  )
}

const BDAY_COLORS = [
  '#f472b6', // pink-400
  '#a78bfa', // violet-400
  '#fbbf24', // amber-400
  '#34d399', // emerald-400
  '#60a5fa', // blue-400
  '#fb923c', // orange-400
]
