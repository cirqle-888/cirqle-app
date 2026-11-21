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
    key: 'autopilot_assign_requests',
    label: 'Give requests to the right designer',
    hint: 'New requests (last 14 days) with nobody assigned go to the person who usually does that client\u2019s work (from the last four months of tasks), so they show in that person\u2019s My Work; the task is created when they start, as now. Requests with no clear designer stay for a person. Runs in the morning and the evening.',
    defaultOn: true,
  },
  {
    key: 'autopilot_billing',
    label: 'Month-end billing check',
    hint: 'On the last two days of the month and the first three of the next: the month\u2019s draft invoices ready to send, finished work on no invoice, and work delivered over a week ago but not marked done (it cannot bill until it is). Draft invoices are already made by themselves when tasks are done; nothing is sent to clients.',
    defaultOn: true,
  },
  {
    key: 'autopilot_mark_posted',
    label: 'Close posts that are live',
    hint: 'Every morning, planned posts that went to Requests and are now live on the client\u2019s connected Instagram or Facebook (same kind of post, from a day before to three days after its date) are marked done: the task is made if there is none (priced from the Pricing Matrix, the request\u2019s designer assigned) and goes on the draft invoice as usual. Requests left open after their task was finished are closed too. Past-date posts with nothing live are listed for you.',
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
