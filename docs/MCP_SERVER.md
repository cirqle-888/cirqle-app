# Cirqle MCP server

Cirqle exposes a [Model Context Protocol](https://modelcontextprotocol.io) server at
`/api/mcp` so an AI client (Claude Desktop, Claude Code, claude.ai custom
connectors, Cursor, …) can read the agency's operational data and file the same
quick actions the iOS Shortcuts API offers.

| | |
|---|---|
| Endpoint | `POST https://<app-host>/api/mcp` (Streamable HTTP, stateless, JSON responses) |
| Auth | `Authorization: Bearer <MCP_API_TOKEN>` |
| Code | `src/app/api/mcp/route.ts` (transport + auth), `src/lib/mcp/server.ts` (tools), `src/lib/shortcut/actions.ts` (write handlers shared with `/api/shortcut`) |

## Trust model — read before handing out the token

The server runs on the **service-role** Supabase client behind **one shared
secret**. There is no per-employee identity, so none of the app's permission or
department scoping applies: whoever holds the token sees what an admin sees and
can create tasks, requests, expenses and payments. Consequently:

- Give the token only to your own AI clients. Never paste it into a shared
  workspace connector other people can use.
- The read tools deliberately do not touch payroll, employee salary or bank
  data, OAuth tokens or client hub/intake tokens.
- Writes land unattributed (no `created_by`), exactly like Shortcuts entries.
- No tool sends anything outside the app (no WhatsApp, email or posting), and
  nothing is deleted once work has started on it.
- The route fails closed: with `MCP_API_TOKEN` unset every request is a 401.
  `src/lib/mcp/route-auth.test.ts` enforces this.

## Setup

1. `MCP_API_TOKEN` is already in `.env.local` (generated 5 Nov 2026). For
   production, add the same variable in Vercel → Project → Settings →
   Environment Variables and redeploy. Rotate with `openssl rand -hex 32`.
2. Connect a client (replace the host for production):

**Claude Code**

```bash
claude mcp add --transport http cirqle http://localhost:3000/api/mcp --header "Authorization: Bearer <MCP_API_TOKEN>"
```

**Claude Desktop / claude.ai** — Settings → Connectors → *Add custom connector*,
URL `https://<app-host>/api/mcp`. If the connector UI has no header field, use
the Claude Code command above or a local stdio bridge such as `mcp-remote`:

```json
{
  "mcpServers": {
    "cirqle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<app-host>/api/mcp", "--header", "Authorization: Bearer <MCP_API_TOKEN>"]
    }
  }
}
```

**Codex (CLI and app)** — `~/.codex/config.toml`:

```toml
[mcp_servers.cirqle]
command = "npx"
args = ["-y", "mcp-remote", "https://<app-host>/api/mcp", "--header", "Authorization: Bearer <MCP_API_TOKEN>"]
```

**Gemini CLI** — `~/.gemini/settings.json`:

```json
{ "mcpServers": { "cirqle": { "httpUrl": "https://<app-host>/api/mcp", "headers": { "Authorization": "Bearer <MCP_API_TOKEN>" } } } }
```

**Cursor / other clients** — any Streamable HTTP MCP client; pass the bearer
header. Chat apps that cannot send a header (ChatGPT, Gemini web) use the
`mcp-remote` bridge from a desktop client, or the Copy for AI buttons in the app.

## Tools

Every tool returns a one-line summary as text plus the raw rows in
`structuredContent`. Client, service, category and bank-account names are
matched fuzzily (`ilike`), exact name wins, else the shortest match.

### Read-only

| Tool | What it does |
|---|---|
| `search` | Clients, tasks, invoices and requests by name/title/number (`#1883`, `INV-0042`). |
| `list_services` | Service catalogue. |
| `list_clients` | Clients, optional name/code filter. |
| `get_client` | One client with open invoices (and INR outstanding), recent tasks, open requests. |
| `list_tasks` | Tasks by client, status, date range; totals the INR billing value. |
| `get_task` | One task by number. |
| `list_invoices` | Invoices by client, status, date range; `outstanding_only` reports amount due. |
| `get_invoice` | One invoice with line items. |
| `list_requests` | Requests inbox (open by default). |
| `cashbook_summary` | Inflow/outflow for a date range grouped by category. |
| `list_social_plan` | One client's Social Calendar plan for a month: dated items and undated ideas. |
| `business_snapshot` | Today in one call: open and overdue requests, tasks by status, outstanding invoices, cash this month, posts in the next 7 days not yet sent to Requests. |
| `upcoming_posts` | Planned posts across clients (or one) for the next N days, and whether each is in Requests. |
| `get_client_card` | A client's Prompt Studio card, its empty fields and what each field accepts. |
| `client_card_research_prompt` | The master prompt for researching a client's pages to fill the card (or study their existing posts). |
| `list_prompt_templates` | Prompt Studio templates, built-in and the team's own, with their fields. |
| `build_prompt` | Fills a template with the client's card, as the Create tab does. |
| `list_prompt_library` | Saved prompts and results, optionally for one client. |
| `get_request` | One request in full by `REQ-0058`: brief, assignee, the task it became. |
| `list_unbilled_work` | Delivered/done billable tasks on no invoice yet, package work listed apart. |
| `list_leads` | Leads by client and status. |
| `list_quotations` | Quotations by client and status. |

### Writes (same handlers as `/api/shortcut`)

| Tool | Effect |
|---|---|
| `create_request` | Files a request in the inbox. |
| `create_request_from_text` | Groq-parses a sentence into a request, then files it. |
| `create_task` | Creates a pending task; price from the Pricing Matrix when amount is omitted. |
| `duplicate_task` | Clones a task to today. |
| `record_expense` | Cash-book outflow; incomplete if category/description missing. |
| `record_payment` | Cash-book inflow allocated FIFO across the client's open invoices. |
| `update_client_card` | Writes Client Card fields (by key or label); choices matched to the allowed options, unknown fields refused, empty values never wipe; `clear` empties a field. |
| `save_to_prompt_library` | Keeps a prompt and its AI result in the client's Prompt Studio library. |
| `update_social_plan_item` | Edits one planned post (title, date or Idea Board, format, platforms, caption, notes, links, reference images). Only the fields given change; posts already in Requests or Tasks are refused. |
| `remove_social_plan_items` | Deletes planned posts no work has started on; the rest are listed back. Marked destructive. |
| `send_social_items_to_requests` | Files planned posts in the Requests inbox like the calendar's *Send to Requests*: full brief, designer deadline (post date minus the lead time), service, atomic claim so a post is never sent twice. Up to 40 a call. |
| `set_task_status` | pending, in_progress, delivered, done or cancelled, with the Tasks page's follow-ups (draft invoices, derived billing, analytics cache, linked requests). Invoiced and paid come only from invoicing. |
| `update_lead` | Lead status and/or an appended, dated note; stamps the first contact. |
| `add_social_plan_items` | Adds approved post ideas to a client's Social Calendar as `planned` items (undated ones land on the Idea Board); creates the month's plan if needed. Skips items already there, saves nothing if one item is invalid, and never sends to Requests, schedules or publishes. Code: `src/lib/social/plan-mcp.ts`. |

### Ready-made prompts

AI apps that show MCP prompts list these as commands: `morning_brief`,
`plan_social_month` (client, month), `fill_client_card` (client, links),
`trend_check` (client). Each walks the AI through the tools above and asks
before it writes.

Code for the newer tools: `src/lib/mcp/tools-automation.ts` (registration),
`social-actions.ts`, `content-actions.ts`, `ops-actions.ts` (logic, tested in
`automation.test.ts`), `shared.ts` (result shape and lookups).

## Adding a tool

Register it in `createCirqleMcpServer()` with `server.registerTool(name, { description, inputSchema (zod shape), annotations }, handler)`.
Keep `readOnlyHint: true` on reads, return `fail(message)` for user errors
(never throw), and respect the trust-model list above when choosing columns.

## Verifying locally

```bash
curl -s http://localhost:3000/api/mcp -H "Authorization: Bearer $MCP_API_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
