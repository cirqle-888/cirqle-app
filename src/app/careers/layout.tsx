import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Careers — Cirqle',
  description: 'Apply to work with Cirqle',
  robots: { index: true, follow: true },
}

/** Public careers application — inherits the root layout (fonts/theme) but
 *  renders no dashboard chrome. Mirrors src/app/intake/layout.tsx. */
export default function CareersLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>
}
