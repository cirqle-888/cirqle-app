# Roadmap

**Updated 5 Aug 2026** — produced by a full audit of `deploy/cirqle-studio`
against every prior plan. Anything not listed here was completed or archived
(see `docs/archive/`). The current architecture is the source of truth:
pricing engine (`lib/tasks/pricing`), finance engine (`lib/finance`), guarded
contribution writes (`contributions/actions.ts`), scope dimension, Connect
modules (chat / timeline / approvals / voice / workspace), key-based
permissions + RLS.

## Deferred — needs a product decision first

| Item | Blocked on |
|---|---|
| Employee pay for retainer-covered work (old Phase 3.4) | The `is_manual_override` question: ~97% of contribution_scores are manual. Decide whether a computed number should ever win before building an engine for it. Re-scope against `lib/tasks/pricing` — do NOT follow the archived spec verbatim. |
| Agreements coverage backfill | Measure how many pre-engine tasks lack coverage stamps in production before deciding whether a backfill is worth it. |
| Partner settlement | Product design. Commission rate is already stored on `business_partners`; nothing reads it yet. |
| Wave D — AI assistant in chat | Redesign needed: the multi-provider registry the old plan promoted was deleted (ADV-01). Design groq-first on today's `lib/ai`. |
| Wave E — Knowledge Base | Sequenced after Wave D; permission-filter matrix is the risk area. |
| Stashes on `main` (×2, July) | Owner review: stash@{0} is a 16-file refactor, stash@{1} is import-client work. Drop or land. |

## Valid, low-urgency

- Approval entry-point buttons on invoice/quotation pages (dialog already accepts defaults)
- Chat polish: presence, typing indicators, web push (VAPID), message edit UI
- Portal scalability (`src/app/portal/[token]/page.tsx` TODOs) — deliberate deferral, no scale pressure
- Android release checklist (`docs/ANDROID_RELEASE.md`) — ops work, gated on doing a release
- Sequential approval chains, voice "played" status, timeline archive cron

## Standing rules

- Cost guardrail: stay ₹0/month on existing free tiers; first accepted cost is Supabase Pro at >500MB.
- Never renumber the `20240001–20240004` migrations (wrong-year prefixes, already applied).
- Migrations are run manually in the Supabase SQL editor — never auto-applied.
