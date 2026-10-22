import { approvedDevicePolicy, loadModuleState, reserveBalance, todayIso } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import SettingsClient from './settings-client'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const state = await loadModuleState(admin)
  const { data: serviceCategories } = await admin.from('service_categories').select('id, name').eq('is_active', true).order('display_order')
  const lastConfirmed = state.runs.filter(r => r.status === 'confirmed').map(r => r.periodEnd).sort().at(-1) ?? null
  const approved = approvedDevicePolicy(state.settings)
  const latestPolicy = state.settings.filter(s => s.devicePolicy).at(-1) ?? null
  return (
    <SettingsClient
      today={todayIso()}
      versions={state.settings.slice().reverse()}
      lastConfirmedEnd={lastConfirmed}
      serviceCategories={(serviceCategories ?? []).map(c => ({ id: c.id, name: c.name }))}
      draftPolicy={latestPolicy?.devicePolicy ?? null}
      approvedAt={approved?.devicePolicyApprovedAt ?? null}
      reserve={state.reserve.slice().reverse()}
      reserveBalanceInr={reserveBalance(state.reserve)}
    />
  )
}
