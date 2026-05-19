import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import { ThemeProvider } from '@/contexts/theme-context'
import { DynamicFavicon } from '@/components/ui/dynamic-favicon'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Cirqle — Business Management',
  description: 'Cirqle Design agency business management system',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full bg-background text-foreground">
        {/* Theme init — loaded before hydration so the first paint is always the
            correct theme (no flash). Using an external file + next/script
            beforeInteractive avoids the React 19 dangerouslySetInnerHTML warning. */}
        <Script id="theme-init" src="/theme-init.js" strategy="beforeInteractive" />
        <DynamicFavicon />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
