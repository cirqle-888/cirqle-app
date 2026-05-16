import Sidebar from '@/components/layout/sidebar'
import { PrivacyProvider } from '@/contexts/privacy-context'
import { RoleProvider } from '@/contexts/role-context'
import { CommandPalette } from '@/components/ui/command-palette'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <PrivacyProvider>
      <RoleProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-background w-full">
            {children}
          </main>
          {/* Global Cmd+K search — rendered at layout level so it floats above everything */}
          <CommandPalette />
        </div>
      </RoleProvider>
    </PrivacyProvider>
  )
}
