# WhatsApp listener: automatic capture from client groups

Written 10 Nov 2026, updated 13 Nov 2026. Status: Cirqle App's side is live at `app.cirqle.work`, and OpenWA
runs on the MacBook (see below). **It has not yet filed a request from a real WhatsApp message.**

## Read this first

This uses [OpenWA](https://github.com/rmyndharis/OpenWA), an unofficial WhatsApp gateway. Its own page says
there is "always a non-zero risk of account restriction or ban", and using it breaks WhatsApp's terms.
Decided by Farooq on 10 Nov 2026: use it, on a spare number only.

**Changed 11 Nov 2026:** the number linked is Cirqle's **main business number** (the one on cirqle.work, in the
client groups), not a spare. Farooq chose to keep it linked and accepts the risk: a ban would cut clients off
from the number they use. If WhatsApp shows any warning or restriction, unlink first (WhatsApp → Linked
devices, or log out in OpenWA), then investigate.

Rules that keep the damage small if it goes wrong:

1. **Spare number was the plan.** With the main number linked, the rules below matter more.
2. **It only listens.** Cirqle App contains no code that sends to WhatsApp (a test checks this). Never use
   OpenWA's dashboard or API to send from the linked number either.
3. **Tell each client** that a Cirqle number in the group reads messages to log requests.
4. **Only listed chats are read.** For any other chat, Cirqle App stores the chat id, the sender's display
   name and the time, and nothing else.
5. **The share shortcut stays** (`docs/WHATSAPP_CAPTURE.md`) for when the listener is down or banned.

OpenWA's code has not been reviewed by us. It holds full access to the linked WhatsApp account, and keeps
messages and the login session unencrypted on its own disk (its security notes say so).

## Installed on the MacBook (10 Nov 2026)

Decided by Farooq: run it on the Mac for now. What exists:

| Thing | Where |
|---|---|
| OpenWA v0.30.0, built | `Cirqle Apps and Tools/openwa/` (about 830 MB; its login, messages and API key live in `openwa/data/`) |
| Cirqle's settings for it | `Cirqle Apps and Tools/openwa-local/openwa.env` (light `baileys` engine, everything on the SSD) |
| Local-only guard | `openwa-local/bind-localhost.cjs`. OpenWA listens on every network interface when run directly; this keeps its dashboard and API reachable from this Mac only (checked: refused on the Wi-Fi address) |
| Start file | `Cirqle Apps and Tools/Start WhatsApp Listener.command` (double-click; keeps the Mac awake; leave its window open) |
| Session | `cirqle-desk`, linked to Cirqle's main number on 11 Nov 2026 |
| Webhook | Points at the live app: `https://app.cirqle.work/api/webhooks/openwa`, events `message.received` and `session.status` |
| Secret | `OPENWA_WEBHOOK_SECRET` in Vercel (Production) and in `cirqle-app/.env.local`, same value on the webhook |

It only works while the Mac is on and awake, the FQLab drive is connected, and the listener window is open.
Cirqle App no longer needs to run on the Mac. Messages that arrive while the listener is off are never
captured: check WhatsApp itself for that period.

On 10–11 Nov the webhook pointed at `http://localhost:3000` (Cirqle App running on the Mac). To go back to
that for testing, change the webhook URL and add `SSRF_ALLOWED_HOSTS=localhost` to `openwa-local/openwa.env`.

To open the dashboard (`http://localhost:2785`) you need OpenWA's API key. Copy it to the clipboard without
showing it: `pbcopy < "openwa/data/.api-key"` (run from the Cirqle Apps and Tools folder).

To update OpenWA later: `git fetch --tags && git checkout <new tag>` in `openwa/`, then `npm ci` and
`npm run build:all` with the npm cache on the SSD (the internal disk is too full for it).

## What it does

A message in a listed chat arrives at Cirqle App within seconds and is handled like this:

| Message | What happens |
|---|---|
| Sent by the listener number itself | Ignored |
| Sent by a Cirqle employee (phone matches an active employee) | Ignored |
| Sticker, video, document, poll, call, deleted message | Ignored |
| "ok", "thanks", an emoji, a greeting | Ignored |
| Text that follows the same person's request from the last 10 minutes | Added to that request |
| Other text | AI decides if it is a request. Yes or unsure: filed. No: ignored |
| Voice note or photo | Always captured: filed, or added to that person's recent request |

A filed request is marked new in **Requests**, admins get a notification, the client comes from the
allow-list, and the voice note or photo is kept and linked. Voice notes are written out by AI; the same
caution as the share shortcut applies (Malayalam accuracy untested, always check against the recording).

Known gaps: a request written as a PDF or video is ignored; a text request the AI wrongly judges as chatter
is lost from the inbox (it is still in WhatsApp); two different requests from one person inside 10 minutes
become one item.

## Set-up

### 1. A server for OpenWA (your decision)

OpenWA must run all day on a machine that can reach the internet. Cirqle App's hosting cannot run it.

| Where | Cost | Catch |
|---|---|---|
| A small cloud server | A monthly fee (check current prices) | Breaks the ₹0-a-month rule |
| Your Mac | ₹0 | Must stay on and awake; the internal disk has under 3 GB free |

Install it by following OpenWA's own README (Docker is its recommended route). Use its lighter `baileys`
engine (`ENGINE_TYPE=baileys`, about 30–80 MB of memory by its own figures). Keep its dashboard and API
private: do not expose port 2785 to the internet. OpenWA only needs to make outgoing calls to Cirqle App.

### 2. Cirqle App

1. Deploy the app.
2. In Vercel → Settings → Environment Variables add **`OPENWA_WEBHOOK_SECRET`**: a long random value
   (`openssl rand -hex 32`). Redeploy. Without it the listener refuses every call.

### 3. Link the spare number and point OpenWA at Cirqle

1. In OpenWA, create a session and link the spare number by scanning its QR code with WhatsApp on the
   spare phone (Linked devices).
2. Register a webhook for that session (OpenWA: `POST /api/sessions/{sessionId}/webhooks`):

   ```json
   {
     "url": "https://app.cirqle.work/api/webhooks/openwa",
     "events": ["message.received", "session.status"],
     "secret": "<the same value as OPENWA_WEBHOOK_SECRET>"
   }
   ```
   `session.status` is what lets Cirqle App warn you when the spare number is logged out or disconnected.
3. Add the spare number to one client group, with the client's agreement.

### 4. Switch it on

In Cirqle App → Settings → Company → **WhatsApp listener**:

1. Get each group's id. Either:
   - ask OpenWA for the groups the spare number is in (`GET /api/sessions/{sessionId}/groups`, with its
     API key), which gives every id with its WhatsApp name; or
   - turn the listener **On** with **Chats to read** empty and save. Nothing is captured, but each group
     that posts appears under **Seen but not listed** after a reload. (While the listener is **Off**, not
     even that is recorded.)
2. Put each id into **Chats to read** as `120363…@g.us = Client name` (the client name as written in Cirqle).
3. Make sure the listener is **On** and save.

To stop everything at once: turn it **Off**. To stop reading one group: delete its line.

**Filter chatter with AI** (same section) is On by default. Turn it Off to capture every message except
"ok", "thanks" and emoji, and pick the real requests yourself in the inbox.

## When AI is unavailable or its free limit is reached

Messages still arrive. Each AI step can fail without stopping the filing:

| AI step | Without it |
|---|---|
| "Is this a request?" check | The text is filed anyway (same as the filter switched Off) |
| Title, service and date suggestion | Title is the first line of the message; the rest is left for staff |
| Voice note transcription | Filed as "WhatsApp voice note — listen and add details", recording attached |
| Photo reading | Photo attached without the text |

The client name is not affected: it comes from the list in Settings, not from AI.

## When the gateway is down (Mac off, server stopped, number logged out)

- Nothing is captured while it is down. Messages stay in WhatsApp on the spare phone.
- **Whether OpenWA delivers missed messages when it comes back is not known** (its docs do not say; not
  tested). Assume they are not captured, and read the group for that period.
- Cirqle App notices in three ways:
  1. If OpenWA reports the session logged out, disconnected, banned or restricted, admins get
     "The WhatsApp listener has stopped" straight away. This needs `session.status` in the webhook, and
     cannot fire when the machine itself is off.
  2. The daily alert job (09:00) warns when the listener is On, chats are listed, and nothing at all has
     arrived for 24 hours. A quiet day in every group looks the same, so the warning says "check".
     Because that job runs once a day, a gateway that died in the morning is reported the next morning.
  3. Settings → Company → WhatsApp listener shows when the gateway was last heard and its last status.
- A linked device that stays offline for a long time may be logged out by WhatsApp; scan the QR code again.
- Use the share shortcut until it is back.

## Seeing what is pending for each client

Each listed chat names its client, so captured requests are filed under that client.
**Requests → Pending by client** (`/dashboard/requests/pending`) shows one row per client: how many
requests are not started, in progress, or waiting on the client, how long the oldest has waited, how many
are past their due date, and how many came from WhatsApp. It also warns when a name in the listener list
matches no client in Cirqle. It is for staff only and never posts to a client or to WhatsApp.

## First week: what to check

- Compare the group with the Requests inbox each day: anything missed, anything filed that was not a request.
- Listen to five voice notes against their transcripts.
- Watch for a notification titled "A WhatsApp message could not be captured".
- In OpenWA, check the session still says connected. A ban or logout shows there first.

## Limits

| Limit | Value |
|---|---|
| Voice note or photo size | 4 MB once decoded. Larger ones are filed with "open the WhatsApp chat to see it" |
| Request size from OpenWA | Vercel refuses bodies over 4.5 MB, so a very large inline photo is not delivered at all |
| Photo reading | Off until `GROQ_VISION_MODEL` is set (photo still attached) |
| AI | Groq free tier; many messages a minute can hit its rate limit, in which case messages are filed without the AI check |

If OpenWA leaves the media out of the webhook, the request says so. Fetching it from OpenWA afterwards is not built.

## How it works inside

| File | What |
|---|---|
| `src/app/api/webhooks/openwa/route.ts` | Checks the signature (`X-OpenWA-Signature: sha256=…` over the raw body), replies at once, then does the work |
| `src/lib/whatsapp-listener/rules.ts` | Reading the message, the allow-list, the decision rules |
| `src/lib/whatsapp-listener/handle.ts` | The flow: ignore, add to a recent request, or file a new one |
| `src/lib/shortcut/whatsapp-capture.ts` | Shared with the share shortcut: keeping, transcribing and labelling files |

Each captured message is recorded on its request's activity timeline (`request_activity`, action
`whatsapp_message`) with its WhatsApp message id. That record is how duplicates are refused and how a
follow-up finds the request to join. No new database table or migration is needed.

Settings are `company_settings` rows. Set by you: `whatsapp_listener_enabled`, `whatsapp_listener_groups`,
`whatsapp_listener_ai_filter`. Written by the listener: `whatsapp_listener_seen`,
`whatsapp_listener_last_heard`, `whatsapp_listener_session` (the Settings page never saves over these).

The message format was taken from OpenWA's `docs/06-api-specification.md` §6.6 and `docs/04-security-design.md`
as published on 10 Nov 2026. If OpenWA changes it, messages will be ignored as unreadable, not misfiled.
