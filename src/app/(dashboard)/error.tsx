'use client'

/**
 * Error boundary for every dashboard page. Sits inside the dashboard layout,
 * so the sidebar and header stay usable when one page fails.
 */
import AppErrorScreen from '@/components/errors/app-error-screen'

export default function DashboardError({ error }: { error: Error & { digest?: string } }) {
  return <AppErrorScreen error={error} boundary="dashboard" />
}
