/**
 * One switch per autopilot job, stored in `company_settings` as 'on' / 'off'
 * and edited in Settings → Company → Automations. Same model as the owner
 * alerts (lib/owner-alerts/switches.ts): a missing row means the default.
 *
 * These jobs do work, not just notify, so each says exactly what it changes.
 */

export const AUTOPILOT_SWITCHES = [
  {
    key: 'autopilot_send_planned_posts',
    label: 'Send planned posts to designers',
    hint: 'Every morning, posts in Active plans whose designer deadline (post date minus the lead time) has come go to Requests, the same as pressing Send to Requests. Draft plans and empty trend slots are never sent.',
    defaultOn: true,
  },
  {
    key: 'autopilot_monthly_drafts',
    label: 'AI drafts next month’s plans',
    hint: 'From the 10th, the app’s AI writes next month’s plan for one social client a day: clients with a Client Card and an Active plan this month. It arrives as a Draft plan to review; mark it Active when it is right.',
    defaultOn: true,
  },
  {
    key: 'autopilot_contribution_check',
    label: 'Contribution and pay check',
    hint: 'Daily, and before pay day: compares finished tasks with who sent the designs in the WhatsApp groups and with the clients’ Instagram posts, and lists missing tasks, missing or wrong contributors and work not billed.',
    defaultOn: true,
  },
  {
    key: 'autopilot_requests_to_tasks',
    label: 'Turn requests into tasks',
    hint: 'When a request is approved, create its task with the client’s usual service and price and the designer who does this client’s work. Requests the app cannot match stay for a person.',
    defaultOn: true,
  },
  {
    key: 'autopilot_billing',
    label: 'Month-end draft invoices and payment reminders',
    hint: 'On the last day of the month, add finished unbilled work to draft invoices; daily, prepare a payment reminder message for each overdue invoice, ready to send from the Follow-ups page.',
    defaultOn: true,
  },
] as const

export type AutopilotKey = (typeof AUTOPILOT_SWITCHES)[number]['key']

export function autopilotOn(settings: Record<string, string | undefined>, key: AutopilotKey): boolean {
  const def = AUTOPILOT_SWITCHES.find(s => s.key === key)?.defaultOn ?? false
  const v = (settings[key] || '').trim().toLowerCase()
  if (v === 'on') return true
  if (v === 'off') return false
  return def
}
