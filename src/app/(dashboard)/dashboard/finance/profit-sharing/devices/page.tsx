import { approvedDevicePolicy, loadDeviceEvents, loadDevices, loadModuleState, todayIso } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import DevicesClient from './devices-client'

export const dynamic = 'force-dynamic'

export default async function DevicesPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const [state, devices, events] = await Promise.all([loadModuleState(admin), loadDevices(admin), loadDeviceEvents(admin)])
  return (
    <DevicesClient
      today={todayIso()}
      policyApproved={!!approvedDevicePolicy(state.settings)}
      members={state.members.filter(m => m.employeeId).map(m => ({ id: m.id, label: m.label }))}
      devices={devices}
      events={events}
      valuations={state.valuations}
    />
  )
}
