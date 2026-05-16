import type { Metadata } from 'next'
import '../globals.css'

export const metadata: Metadata = {
  title: 'Employee Portal — cirqle',
  description: 'cirqle employee contribution portal',
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  )
}
