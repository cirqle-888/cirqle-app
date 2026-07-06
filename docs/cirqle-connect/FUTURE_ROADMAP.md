# Cirqle Connect Phase 2+ — Future Roadmap

What comes after the six features ship, plus improvements beyond the requested ideas. Ordered by value-per-effort at Cirqle's scale.

---

## 1. Semantic search / embeddings (the planned "later")

The schema is already ready: `kb_chunks.embedding vector(768)` sits empty, pgvector extension enabled, retrieval isolated in one function.

Rollout when wanted:
1. Backfill job embeds existing chunks (batched through the jobs engine); new chunks embed at index time.
2. Add HNSW index; `searchKb` becomes hybrid: FTS + cosine similarity, reciprocal-rank fused.
3. Cost: free-tier embedding models via Groq/Gemini, or OpenAI `text-embedding-3-small` ≈ **$1–5/mo** at this volume. DB impact: 768 floats ≈ 3 KB/chunk → roughly 4× kb_chunks size — plan this *after* Supabase Pro.

Payoff: "Show previous Ramadan campaign" works by meaning, not keyword; cross-language matching (Malayalam ↔ English) improves dramatically — likely the single biggest quality jump for the KB.

## 2. Notification delivery upgrades

- **Web push** (VAPID, free, no vendor): mentions, approval requests, reminders reach closed tabs — biggest daily-life improvement after chat ships.
- **Daily digest email** (Resend, within free 100/day): unread mentions + pending approvals + today's planner each morning — reuses timeline + workspace queries.
- Quiet hours + per-category notification preferences on the employee profile.

## 3. Client-facing extensions (careful, high value)

- **Client approval portals**: extend the approval engine to tokenized portal pages — clients approve designs/quotations from the same engine (`approver_portal_token` variant). The careers/intake portal pattern already proves the token model. This closes the loop: internal approval → client approval → invoice.
- **Portal AI summaries** (deliberate, later): weekly auto-summary of a client's project room posted to their portal — content passes a human approval first (the approval engine, naturally).

## 4. Automation rules (the biggest "beyond the ideas" suggestion)

A tiny rule engine over the event backbone this design already creates — because every event flows through `logActivity()`, automations get their trigger stream for free:

```
WHEN invoice.paid            → post 🎉 message to client room + notify contributors
WHEN task.status=review      → auto-create approval for the task's project lead
WHEN client inactive 30 days → create follow-up task for account owner
WHEN approval pending > 48h  → escalate notification to admins
```

Schema: `automation_rules (trigger_pattern, condition jsonb, action jsonb)` + a dispatcher in the existing jobs worker. Start with 4–5 hardcoded recipes behind settings toggles; generalize to a rule builder UI only if usage proves it. This is how the CRM starts feeling *alive* rather than recorded.

## 5. Meetings layer

After voice notes + AI prove out: meeting rooms (chat plan Phase 5 P2P calls) + recording → Whisper transcription → AI minutes posted to the room → decisions/actions extracted into tasks via the proposal flow. Every piece already exists in this design; this is composition, not new architecture.

## 6. Mobile app shell

The dashboard is already responsive with a bottom-nav; when chat + voice land, wrap in Capacitor (free) for a store-installable app with real push notifications. Zero backend change. Trigger: when the team lives in chat daily.

## 7. Data lifecycle & ops maturity

- Timeline/message archive tiers (24-month policy from DATABASE_SCHEMA §1.4) + monthly `pg_dump` to a private storage bucket (free, cron) — Supabase free tier has no PITR; this is the honest backup gap to close *before* the org's memory lives in chat + KB.
- A `/dashboard/admin/usage` page over `ai_usage` + storage + DB-size metrics — see the cost walls approaching (COST_ANALYSIS) instead of hitting them.
- Rate limiting on portal endpoints (token guessing) — small, worth doing during Wave B.

## 8. Longer horizon

- **OKR / goals module** riding the same timeline backbone (progress events).
- **Client health scores** feeding from timeline density (response times, activity gaps) — the data accrues from day one of Wave A.
- **E-signatures** on approvals (draw-to-sign on portal approval pages) for quotations/agreements.
- **Multi-workspace** (if Cirqle ever runs sister brands): the schema is single-tenant; multi-tenancy would add `workspace_id` everywhere — documented as a known non-goal now so nothing accidentally hard-blocks it.

## Suggested sequence after the six features

1. Web push + digest (small, immediate daily value)
2. Automation recipes v1 (hardcoded)
3. Client approval portals
4. Embeddings/hybrid search
5. Meetings layer
6. Capacitor app

Each is 2–6 sessions and independently valuable; none creates mandatory new cost except embeddings (~$1–5/mo, optional).
