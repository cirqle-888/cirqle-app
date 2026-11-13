/**
 * One switch per owner automation, stored in `company_settings` as 'on' / 'off'
 * and edited in Settings → Company → Owner alerts.
 *
 * A missing row means the default below, so a fresh deploy behaves sensibly
 * with no settings work, and any one alert can be silenced without a deploy.
 * The in-app alerts default ON (they only notify admins). Email defaults OFF:
 * it leaves the app, so somebody should choose it.
 */

export const OWNER_ALERT_SWITCHES = [
  {
    key: 'owner_alert_overdue_escalation',
    label: 'Overdue invoice escalation',
    hint: 'Alert again at 7, 14 and 30 days overdue. The 7 and 14-day alerts wait while a promise or chase date is set.',
    defaultOn: true,
  },
  {
    key: 'owner_alert_unsent_invoices',
    label: 'Invoices not sent',
    hint: 'Alert when a draft or reviewed invoice is still unsent 3 days after its date.',
    defaultOn: true,
  },
  {
    key: 'owner_alert_quiet_clients',
    label: 'Clients going quiet',
    hint: 'Alert when a regular client (work in 3 of the last 6 months) has had no job for 3 weeks.',
    defaultOn: true,
  },
  {
    key: 'owner_alert_weekly_check',
    label: 'Monday owner check',
    hint: 'Every Monday morning, one notification listing everything that needs you. Also shown on Business Health.',
    defaultOn: true,
  },
  {
    key: 'owner_alert_weekly_email',
    label: 'Email the Monday owner check',
    hint: 'Also email it to admins. Needs email sending (Resend) configured on the server.',
    defaultOn: false,
  },
] as const

export type OwnerAlertKey = (typeof OWNER_ALERT_SWITCHES)[number]['key']

export function ownerAlertOn(settings: Record<string, string | undefined>, key: OwnerAlertKey): boolean {
  const def = OWNER_ALERT_SWITCHES.find(s => s.key === key)?.defaultOn ?? false
  const v = (settings[key] || '').trim().toLowerCase()
  if (v === 'on') return true
  if (v === 'off') return false
  return def
}
