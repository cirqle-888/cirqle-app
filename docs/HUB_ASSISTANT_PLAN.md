# Plan: "Ask the Hub" chat inside the Cirqle app

Status: PLAN, nothing built yet. Written 6 Nov 2026.
Decided by Farooq (6 Nov 2026): hub runs on the Mac behind a free Cloudflare Tunnel; the chat uses Groq.

## What it is

A chat page in the app where you (later, staff) ask about a client in plain words:
"What should we offer Sea Star next?", "How is Malabar Kitchen's website doing?",
"Plan December posts for Roots". Groq reads the question, calls the Cirqle
Marketing Hub's tools, and answers with the hub's numbers.

The hub stays the research engine (Python, on the Mac, client folders on FQLab).
The app stays the system of record. The chat only reads from the hub and
records drafts; it never posts, sends or publishes anything.

## How the pieces connect

```
Browser  ->  app.cirqle.work /api/assistant  (Vercel, checks login + permission)
                 |  Groq chat with tools (GROQ_API_KEY, already in the app)
                 |  MCP client  ->  https://hub.<domain>/mcp   (HUB_MCP_URL + HUB_API_KEY, server-only)
                 v
         Cloudflare Tunnel  ->  Mac: python -m hub serve-mcp --http  (127.0.0.1:8765)
                                     brands/ on FQLab
```

- The hub already has an HTTP mode (`serve-mcp --http`) that rejects any request
  without its agency key (`BearerAuth` in hub/mcp_server.py). The tunnel adds HTTPS.
- Client link: `erp sync` already writes each brand's app client id into
  `brands/<slug>/brand.json` (`erp.id`), so the app can turn "this client" into
  the right hub brand with no new table.

## Phases

### Phase 0: Hub online from the Mac (about half a day, ₹0)
1. Install `cloudflared` (Homebrew) and create a **named** tunnel (a quick
   `trycloudflare.com` tunnel changes its address every run, so it won't do).
2. Hostname, e.g. `hub.cirqle.work`. **Needs cirqle.work's DNS to be on
   Cloudflare** (VERIFY where it is now; app.cirqle.work points at Vercel and
   must keep working). If moving DNS is not wanted, use a spare domain on Cloudflare.
3. Optional second lock: Cloudflare Access service token in front of the
   hostname (free), sent by the app as two extra headers.
4. Double-click file in the hub folder: "Start Hub Online.command" (starts the
   hub's HTTP mode and the tunnel; later a launchd job so it starts at login).
5. Mac must be on, awake and have FQLab mounted. Energy settings: prevent sleep
   when on power, or run `caffeinate` from the start script.

### Phase 1: Chat for Farooq only (about 2–3 days)
App files (names to confirm when building):
- `src/lib/hub/client.ts`: server-only MCP client (`@modelcontextprotocol/sdk`
  Client + Streamable HTTP transport, already a dependency). Env: `HUB_MCP_URL`,
  `HUB_API_KEY` (Vercel, never `NEXT_PUBLIC_`). 10 s connect timeout; if the hub
  doesn't answer: "The hub is offline (the Mac may be asleep)".
- `src/lib/hub/assistant.ts`: Groq tool loop on the OpenAI-compatible endpoint
  that `src/lib/ai/groq.ts` already uses. Hub tools converted to Groq function
  tools, at most 6 tool steps, whole answer inside the route's 60 s limit.
  Model: `GROQ_ASSISTANT_MODEL` (start with `openai/gpt-oss-120b`, compare with
  `llama-3.3-70b-versatile`; Groq retires ids, VERIFY both exist).
- `src/app/api/assistant/route.ts`: POST, needs a logged-in user with a new
  permission (`ASSISTANT_USE`), owner only at first.
- `src/app/(dashboard)/dashboard/assistant/`: simple chat page with a client
  picker. Conversation kept in the browser only (no new table in Phase 1).

Tools the chat may use (allow-list, enforced in `client.ts`, not just in the prompt):
| Hub tool | Allowed | Why |
|---|---|---|
| `view` (services, doctor, ai, summary, calendar, markets…) | yes | read |
| `actions`, `search`, `report` | yes | read / writes a report file |
| `audit` | yes | reads the client's public website |
| `plan` | yes, but `save` forced to false | a person approves before saving |
| `brand` | only `list`, `profile`, `erp_status` | no creating brands from chat |
| `do`, `import_data`, `sync`, `updates`, `dashboard`, `ui_data` | no | writes, slow external calls, or UI-only |

System prompt: the hub's own rules (facts only from facts.md, never invent
figures, rates with numerator/denominator, unchecked is "not checked", draft only)
plus Cirqle's: plain, simple words for local business owners.

### Phase 2: Hub results on each client page, no chat (about 1–2 days)
On `/dashboard/marketing/[clientId]`: service suggestions (`view services`),
website score, this month's plan. Same `client.ts`; no AI involved, so no
wrong answers, and useful to staff even when the chat isn't.

### Phase 3: Staff (about 2–3 days)
- Permission per role; each staff member only sees clients they can already see.
- Question log table (migration written as a file, run by hand in the Supabase
  SQL editor, as the app's rules require).
- Rate limit per user (Groq free-tier limits are shared by everyone).

## Risks and limits
- **Mac offline = chat offline.** Fine for Farooq; staff will notice. The page
  must say so clearly instead of failing silently.
- **Groq is weaker at tool use** than paid models: expect some wrong tool
  choices or half answers. Mitigations: few tools (allow-list), short brief
  results (the hub's lean mode), one retry on a bad tool call, show which tools
  were used under each answer.
- **Groq free tier limits** (requests and tokens per minute): fine for one user;
  check before Phase 3.
- **Client data goes to Groq.** VERIFY Groq's current terms on use of API data
  before staff use it with every client.
- **The hub's agency key opens every brand.** It lives only in Vercel's server
  env; the browser never sees it.
- **Tunnel exposure.** The hub refuses requests without the key; Cloudflare
  Access adds a second lock. Keep `serve-mcp` bound to 127.0.0.1 so only the
  tunnel can reach it.

## Decisions needed before Phase 0
1. Hostname: is cirqle.work's DNS on Cloudflare, or use another domain?
2. Phase 1 user: Farooq only (recommended), or a staff member too?
3. Add Cloudflare Access as a second lock? (recommended; free)
