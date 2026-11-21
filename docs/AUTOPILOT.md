# Autopilot

Daily jobs that do Cirqle's routine work by themselves and tell admins what
they did. Each has an On/Off switch in **Settings → Company → Automations**
(all default On). Code: `src/lib/autopilot/`, cron `/api/cron/autopilot`
(07:00 IST), listed on Business Health.

| Job | When | What it changes |
| --- | --- | --- |
| Send planned posts to designers | every morning | Posts in **Active** plans whose designer deadline (post date minus the lead time) has come go to Requests, like *Send to Requests*. Draft plans and empty `TREND SLOT`s are never sent; empty slots are reported. |
| Give requests to the right designer | morning, and 19:30 with the WhatsApp reports | Open, unassigned requests go to the person who clearly does that client's work (task assignments of the last 120 days, same service counted 3x, at least half the history and two jobs). They appear in that person's My Work; starting the card creates and prices the task as before. |
| Contribution and pay check | every morning; summary on Mondays and days 1-7 | Nothing: it reports. Page: Contributions → **Auto check**. Finished tasks with nobody credited, designs posted in a client's WhatsApp group by someone not credited, designs sent with no task, live Instagram/Facebook posts with no task, unbilled work, last month's salaries due within 3 days or late. |
| Month-end billing check | last 2 days and first 3 | Nothing: it reports the month's draft invoices to send, done work on no invoice and work left at Delivered for a week. Draft invoices already make themselves when tasks are done. |
| AI drafts next month's plans | from the 10th, one client a day | The app's AI (Groq) writes next month's plan for a client with an Active plan this month and a Client Card, as a **Draft** plan; admins and the person who made this month's plan are told. Review it and press **Mark Active** at the top of the plan; then the first job takes over. |

## Limits worth knowing

- The app's AI is Groq's free plan: no web search, about 8,000 tokens a
  minute and 200,000 a day for every AI feature together. Drafts are written
  half a month per call, one client a day; festival dates it is unsure of say
  "(check date)". A paid Groq plan (or `GROQ_MODEL`) removes the limit.
- WhatsApp checks only see groups on the listener's list whose name matches a
  client, and people whose phone number is on their employee record.
- Instagram checks only see client pages connected under Social.
- Nothing here messages clients, posts, or changes contributions or payroll.

## Claude scheduled tasks

With the Cirqle connector added in Claude (see `MCP_SERVER.md`), Claude can
run the work that needs web search: a weekly trend check that fills the
`TREND SLOT`s and a morning brief. Those are set up in Claude, not here.
