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

**Cursor / other clients** — any Streamable HTTP MCP client; pass the bearer
header.

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

### Writes (same handlers as `/api/shortcut`)

| Tool | Effect |
|---|---|
| `create_request` | Files a request in the inbox. |
| `create_request_from_text` | Groq-parses a sentence into a request, then files it. |
| `create_task` | Creates a pending task; price from the Pricing Matrix when amount is omitted. |
| `duplicate_task` | Clones a task to today. |
| `record_expense` | Cash-book outflow; incomplete if category/description missing. |
| `record_payment` | Cash-book inflow allocated FIFO across the client's open invoices. |

## Adding a tool

Register it in `createCirqleMcpServer()` with `server.registerTool(name, { description, inputSchema (zod shape), annotations }, handler)`.
Keep `readOnlyHint: true` on reads, return `fail(message)` for user errors
(never throw), and respect the trust-model list above when choosing columns.

## Verifying locally

```bash
curl -s http://localhost:3000/api/mcp -H "Authorization: Bearer $MCP_API_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
