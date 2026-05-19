import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import { ThemeProvider, themeInitScript } from '@/contexts/theme-context'
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
      <head>
        {/* Theme init — runs before hydration to prevent flash of wrong theme.
            Using next/script with beforeInteractive so Next.js handles it
            correctly without triggering React's script-tag console warning. */}
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-full bg-background text-foreground">
        <DynamicFavicon />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
