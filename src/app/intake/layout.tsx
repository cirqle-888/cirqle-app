import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Submit a Request — Cirqle Works',
  description: 'Send your design requests and track their progress',
  robots: { index: false, follow: false },
}

/** Public intake portal — inherits the root layout (fonts/theme) but renders
 *  no app chrome whatsoever. All data scoping happens in the token actions. */
export default function IntakeLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>
}
