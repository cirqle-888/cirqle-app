'use client'

import Link from 'next/link'

/** Tab bar shown on a public intake form when the client reached it via their
 *  Hub link and has more than one app enabled — lets them switch between
 *  Offer Intake / Standard Request without going back through the hub menu. */
export function IntakeAppSwitcher({ options, current, dark }: {
  options: { kind: string; label: string; href: string }[]
  current: string
  dark?: boolean
}) {
  if (options.length < 2) return null
  return (
    <div className={`flex items-center justify-center gap-1 mb-6 p-1 rounded-xl mx-auto w-fit ${dark ? 'bg-white/5 border border-white/10' : 'bg-secondary border border-border'}`}>
      {options.map(o => (
        <Link
          key={o.kind}
          href={o.href}
          className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            o.kind === current
              ? (dark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-500/15 text-violet-600 dark:text-violet-400')
              : (dark ? 'text-white/40 hover:text-white/70' : 'text-muted-foreground hover:text-foreground')
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  )
}
