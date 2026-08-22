import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Employee Portal — cirqle',
  description: 'cirqle employee contribution portal',
}

/**
 * A NESTED layout, so it must not render <html> or <body> — the root layout
 * already does. It used to render both, which put a second <html> inside the
 * first: the browser unwrapped the invalid nesting, React reported a hydration
 * mismatch on every portal view, and the page lost the root's font variables
 * (--font-inter / --font-geist-mono are declared on the root <html>).
 *
 * The forced dark treatment is kept — the portal is a public, branded page and
 * does not follow the viewer's dashboard theme — but as a wrapper element
 * rather than a duplicate document.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      {children}
    </div>
  )
}
