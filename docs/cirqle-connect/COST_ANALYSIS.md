# Cirqle Connect Phase 2+ — Cost Analysis

Bottom line: **everything in this design runs at ₹0/month** on the current stack (Supabase free + Vercel Hobby + Groq free + Resend free), for a team of ~15 doing heavy daily use, for roughly the first 4–6 months. The first unavoidable cost is **Supabase Pro ($25/mo ≈ ₹2,100)** when the database outgrows 500 MB — everything else stays free far longer.

---

## 1. Per-feature free-tier consumption

### Database (Supabase free: 500 MB)

| Feature | Growth (busy 15-person team) | 1 year |
|---|---|---|
| activity_logs (extended) | ~500 rows/day × ~0.4 KB | ~70 MB |
| messages + attachments meta (chat plan) | ~1,000 rows/day × ~1 KB | ~350 MB |
| kb_chunks | mirrors messages+tasks ≈ 1,200/day × ~1 KB | ~430 MB |
| approvals + events | ~30/day | ~4 MB |
| workspace_items | ~60/day | ~9 MB |
| ai_usage | ~150/day × 0.2 KB | ~11 MB |
| kb_documents (+revisions) | manual volume | < 10 MB |

**Total worst-case ≈ 0.9 GB/year.** Free tier covers ~5 months of *maximum* use; realistic early usage is 2–3× lighter (≈ 10–12 months). Levers before paying: prune kb_chunks for messages > 12 months old (searchable via archive later), timeline archive at 24 months, don't index low-value sources (reactions, system msgs). **Pro (8 GB) covers ~8 years at worst case.**

### Storage (free: 1 GB)

| Item | Math |
|---|---|
| Voice notes @ 32 kbps Opus | 1 min ≈ 240 KB → **1 GB ≈ 70 hours** |
| 15 people × 5 voice-min/day | ~18 MB/day → free tier ≈ 2 months of *heavy* voice use |
| Chat files (10 MB cap, compressed images) | dominant unknown — team-dependent |

Levers: image compression client-side (already planned), 30-day cleanup of deleted-message objects, optional 90-day voice retention setting. Pro = 100 GB (years). Egress (5 GB/mo free): signed-URL audio streaming counts — 5 GB ≈ 350 hours of *listening*/mo; fine.

### Groq (free tier) — AI + transcription

| Use | Consumption | Free-tier fit |
|---|---|---|
| Assistant actions | ~2–4k tokens/action; limits ~30 req/min, daily token caps | 20/employee/hr rate limit keeps a 15-person team comfortably inside |
| Whisper transcription | ~25 s audio/sec processing; generous daily minutes | ~75 voice-min/day team-wide ≈ well within limits |
| KB ask-answers | ~3–6k tokens each | fine at tens/day |

Groq limits change; the design records every call in `ai_usage` so you SEE consumption before hitting walls. If exceeded: queue + retry (jobs engine) absorbs bursts; hard daily budget per employee stops runaway use.

### Realtime / Vercel / Resend

No change from the chat plan: no new always-on subscriptions; no new cron jobs (sweeps ride existing daily crons); notification emails remain digest-only within Resend's 100/day.

## 2. Cost timeline

| Stage | Monthly cost | Trigger |
|---|---|---|
| Launch → ~4–6 months heavy use | **₹0** | — |
| DB > 500 MB or storage > 1 GB | **$25** (Supabase Pro) | inevitable with voice + kb_chunks; also removes inactivity pause |
| Want GPT-4/Claude-class AI quality | + provider spend (est. **$5–30/mo** at this scale, usage-based) | optional — Groq stays default |
| Embeddings phase (FUTURE_ROADMAP) | ₹0 self-hosted via Groq/free models, or ~$1–5/mo via OpenAI embeddings at this volume | optional |
| Group voice/video calls | $0 (P2P) → ~$10/mo (LiveKit VPS) | per chat plan |

**Realistic 12-month projection: ₹0 for ~5 months, then $25/mo.** Nothing in this architecture creates a second mandatory bill.

## 3. Free-tier limitation summary (what you feel, when)

1. **DB 500 MB** — the real constraint. kb_chunks is the biggest consumer *by design choice*; disabling message-chunk indexing halves growth if you want to stretch free longer (KB then searches docs/tasks only).
2. **Groq rate limits** — burst ceilings, not monthly caps. Felt as "assistant queued for a minute" on simultaneous use; invisible otherwise.
3. **Storage 1 GB** — voice + shared files; felt in ~2 months of heavy voice unless retention lever is on.
4. **Egress 5 GB/mo** — only if the team streams lots of audio/files; thumbnails + caching keep this quiet.
5. **Supabase inactivity pause** — moot (daily crons + daily usage).
6. **Vercel Hobby 10 s function limit** — AI streaming route uses SSE within limits; long jobs go through the jobs engine cron. Already the pattern for report generation (60 s `maxDuration`).
