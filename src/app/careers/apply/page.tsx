import { getOpenPositions } from './actions'
import ApplyClient from './apply-client'

export const dynamic = 'force-dynamic'

export default async function CareersApplyPage() {
  const positionsRes = await getOpenPositions()
  const positions = positionsRes.ok ? positionsRes.data : []
  return <ApplyClient positions={positions} />
}
