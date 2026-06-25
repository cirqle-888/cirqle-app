import CaptureClient from './capture-client'

export const metadata = { title: 'Capture · Cirqle' }

/**
 * Quick Capture — paste (or forward from the desktop app) any snippet; the
 * Capture Engine classifies it, detects the client, and prepares a draft for
 * review before it commits to the right module.
 */
export default function CapturePage() {
  return <CaptureClient />
}
