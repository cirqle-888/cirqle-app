# Cirqle Studio — Phase 1 Production Validation Report

Date: 25 July 2026 · Validator: Claude (Cowork session) · Deployed commit: `5a1e220` (merge to main)

---

## 1 · Production validation

### Live checks — run against https://app.cirqle.work AFTER deploy (all executed in the owner's authenticated browser; the secret never left the page)

| # | Check | Expected | Result | Status |
|---|-------|----------|--------|--------|
| 1 | `GET /api/figma/offers`, no auth | 401 JSON, not 404/500 | **401 + "Unauthorized" JSON** | ✅ |
| 2 | `GET /api/figma/offers`, wrong Bearer | 401 | **401 + "Unauthorized" JSON** | ✅ |
| 3 | `GET /api/figma/offers`, valid Bearer | 200 + offer list | **200, 3 active offers, all fields present, 478 ms** | ✅ |
| 4 | Sea Star in list | 22 products, active | **"Weekly Offer" · 22 products · 1 page · active** | ✅ |
| 5 | `GET /api/figma/campaign/:id` (Sea Star) | full shape | **200 in 469 ms** — see below | ✅ |
| 6 | `GET /api/figma/campaign/<unknown-uuid>` | 404 with explanation, never 500 | **404, 527 ms** | ✅ |

Campaign shape verification (Sea Star, live production data):
- 22 products · **names 22/22 · prices 22/22 · MRP 22/22** ✅
- Badges: `B1G1` on Santoor Hand Wash — matches source (Blue Wash's "Buy 1 Get 1"
  correctly travels in **Offer Text**, not Badges, exactly as the Sheet pipeline does) ✅
- `category` field present on every product ✅ (values null where no catalog link — documented)
- `imageUrl`: 1 of 22 (only Butterfly Facial Tissue has a photo — matches Cirqle) ✅
- Bindings: **17 headers · 22 rows · row/product alignment TRUE** ✅
- Spot check row 1: `Mamypoko Extra Absorb Xl22/L28 · 305 · 399` — byte-identical to the source WhatsApp list ✅

Pre-deploy note kept for the record: the first validation run (before push) returned
404 — caught, diagnosed as deploy gap, resolved via merge `5a1e220`, re-validated green.

**One-command rerun after deploy:**
```bash
export CIRQLE_SECRET='<Apps → Offer Intake → Shared sync script → secret>'
bash figma-plugin/cirqle-studio/scripts/validate-figma-api.sh
```
The script covers checks 1–3 plus wrong-token (401) and unknown-campaign (404)
failure cases, verifies all nine product fields, the 17-column bindings
contract, and row/product alignment, and prints response times. Exit 0 = all pass.

### Pre-deployment checks (all verified)

| Check | Evidence | Status |
|-------|----------|--------|
| `npx tsc --noEmit -p .` | clean exit, user terminal | ✅ |
| `npm run build` | Compiled 13.6 s, TS 22.9 s, 35/35 pages, both routes in table | ✅ |
| Route logic type-check vs real `offer-sheet.ts` + `supabase/server.ts` | strict shadow project, PASS | ✅ |
| No new `no-explicit-any` lint errors | routes rewritten with local row types, zero `any` | ✅ |
| Plugin compiles under strict TS | `tsc -p plugin/`, dist/code.js syntax-checked | ✅ |
| UI element wiring | all `$(‘id’)` references resolve, script parses | ✅ |
| Sheet permissions | 18 sheets: cirqleworkspace = Editor, Anyone-with-link = Viewer | ✅ |
| Sea Star source data | 22 products, prices+MRP verified in app, 2 badges (Buy 1 Get 1, B1G1), 17-column sheet written by pipeline | ✅ |

### Figma manual test (requires a human — dev plugins only run in Figma desktop)

Run `docs/TESTING.md` steps 1-10 after deploy. Expected for Sea Star today:
Validate reports a **warning** (22 products, no photos in Cirqle → placeholders),
which is designed behavior. Items that cannot be validated from outside Figma:
template detection UX, component duplication, build speed feel, memory — all
scripted in TESTING.md with pass criteria.

---

## 2 · Performance report

**Measured in production (22-product campaign, Vercel sin1, from the office network):**
`/offers` **478 ms** · `/campaign/:id` **469 ms** · unknown-id 404 **527 ms** —
all inside the 300–900 ms projection band. API latency is a non-issue for this
workflow; the plugin-side image downloads remain the dominant cost (below).

**Projected (design analysis, to confirm post-deploy):**

| Stage | 22 products | 50 | 100 | Driver |
|-------|-------------|----|-----|--------|
| `/offers` | 200–600 ms | same | same | 1 indexed query, rows ≈ campaigns |
| `/campaign/:id` | 300–900 ms | +~10% | +~20% | 1 nested query; payload ~2–10 KB/product |
| Image downloads (plugin) | **5–20 s** | 12–45 s | 25–90 s | **sequential** fetch per product — dominant cost |
| Card build (clone+fill) | 1–3 s | 2–6 s | 5–12 s | font loads amortise after first card |
| Memory (plugin) | ~2× total image bytes | linear | linear | bytes held in UI + copied to sandbox |

**Bottleneck #1: sequential image downloads.** Phase 2 fix: batch 4–6 parallel
fetches (one small change in `ui.html`). Expected 3–5× faster on image-heavy
offers. **Bottleneck #2:** none observed at 22-product scale; at 100+, per-card
`findAll` walks are the next candidate (cache token→node paths per template).

---

## 3 · Security report

| Requirement | Verdict | Notes |
|-------------|---------|-------|
| Fail closed | ✅ | Unset/blank secret rejects ALL requests; no-token and wrong-token both 401. |
| Bearer authentication | ✅ | Same workspace secret as Sheets sync — no new credential class. |
| Read-only API | ✅ | Both routes are GET/OPTIONS only; no mutation anywhere. |
| No write routes | ✅ | Verified: only figma/offers + figma/campaign/[id] added. |
| No secret exposed in code | ✅ | Secret read from company_settings at request time; never logged, never in responses. |
| No token leaks in plugin | ✅ | Token field is `type=password`; stored in figma.clientStorage (machine-local); never printed to the log panel; validation tests here never echoed it into the transcript. |
| No console secrets | ✅ | Plugin has no console.log of settings; API errors return messages, not config. |
| CORS `*` | ⚠️ acceptable | Required (plugin iframe origin is `null`). Gate is the bearer token; CORS only governs response readability. Documented in code. |

**Residual risks (accepted for Phase 1, addressed in Phase 2):**
1. Workspace-wide secret — one credential for all designers; revocation = rotate
   for everyone (identical blast radius to the existing Sheets sync). → Phase 2 #1.
2. `figma.clientStorage` is plaintext on the designer's machine (Figma platform
   standard; same as every plugin storing tokens).
3. Rate limiting relies on Vercel platform defaults; no per-route throttle.

---

## 4 · Plugin UX review

**Working well:** spec-exact sidebar order (connect → select → act → status);
three-chip status is glanceable; every error carries what/where/fix; unknown
`#token` typo detection names the valid columns; empty values hide layers
rather than printing blanks; settings persist per machine.

**Friction found (improvements only — not implemented, per instructions):**
1. After Connect, the first client is selected but the offer isn't auto-loaded —
   one extra click ("Load Offers") that could collapse into selection change.
2. Template dropdown scans only the current page — correct per spec, but a
   one-line hint ("open your template page first") would pre-empt the empty state.
3. Validate is optional before Build; consider auto-running it and showing the
   chip, keeping Build enabled on warnings.
4. Image download progress is a single bar; per-product names stream to the log
   only on failure. A "12/22 images" counter would read better.
5. No "token visibility" toggle on the password field; minor.
6. Preview table truncates long product names at ~130 px; tooltip would help.

---

## 4b · Post-Phase-1 findings (Phase 1.5 build, all fixed)

Four real defects were found by testing after the initial GO, each caught
before it reached a flyer:

| # | Found by | Defect | Fix |
|---|----------|--------|-----|
| 1 | First live plugin Connect | **Session middleware 307-redirected `/api/figma/*` to `/login`.** The routes were correct and CORS-complete, but the plugin iframe carries no cookies, so its preflight was redirected — and browsers reject redirected preflights ("Redirect is not allowed for a preflight request"). Invisible to my earlier API tests, which ran inside an authenticated browser session. | `/api/figma/` added to the `isPublic` list in `src/lib/supabase/middleware.ts` — the same exemption the codebase already had for `/api/cron/`. Bearer auth remains the sole gate. |
| 2 | Live parse of a real 3-section message | **Groq 429 killed the middle section.** Sections were parsed in parallel; three concurrent calls exceeded the free tier's 12k tokens/minute ("Limit 12000, Used 8282, Requested 4461"). On a real Sunday+Monday paste a third of the products would have vanished. | Sections now parse **sequentially**; `callGroqJSON`'s existing backoff absorbs the rest. Raw provider error translated into "wait ~30s and press Parse again". |
| 3 | Full-chain price test | **Comma prices corrupted names and values.** `Rice Ponni 11,50` split at the comma → product `"Rice Ponni 11"` priced `50`; `Rice 1,250` would have printed ₹250. | A comma between digits is now part of the number. `parsePrice` resolves by digit count: 1–2 digits = decimal (`11,50`→11.50), 3 = thousands (`1,250`→1250). |
| 4 | Price-1/2 review | **Decimal prices were rejected by the number inputs** (default `step=1` flags `20.99` and steps by whole rupees) — latent, since Sea Star is all whole rupees, but broken on the first paise price. | `step="0.01"`, plus normalise-on-blur (`11.5` → `11.50`) and a live P1·P2 preview column. |

Two template traps were also closed in Validate: `#price1` without `#price2`
(paise dropped silently) and `#offerprice` alongside the pair (price printed
twice).

**Parity verified by differential test, not assumption:**
plugin `formatProductName` vs `src/lib/format-product-name.ts` — identical
across 30 cases; plugin `splitPrice` vs `src/lib/offer-sheet.ts` — identical
across 11 values including `11.5`, `11.05`, `0.99`, `999.95`, `null`.

## 5 · Known issues

| # | Issue | Severity | Owner action |
|---|-------|----------|--------------|
| 1 | Routes not deployed (the only Phase-1 blocker) | blocker | commit + push |
| 2 | `brand`/`sku` return null — schema has no linked source (documented in LIMITATIONS.md) | info | schema decision |
| 3 | `category` null for products typed free-form without catalog link | info | expected |
| 4 | Sea Star's 22 products have no photos → placeholders in first Figma test | info | expected/by design |
| 5 | The 18 new client sheets are OWNED by cqid01, shared to cirqleworkspace (works, but ownership split across accounts) | low | optional cleanup |
| 6 | Sequential image downloads (see Performance) | low | Phase 2 |
| 7 | Device-bridge VM mount reads empty in this session (blocked running repo commands remotely; file sync unaffected) | env-only | restart desktop app |
| 8 | Studio has no watch-mode/auto-export yet — prototype exists in Flyer Kit v2 | planned | Phase 2 #5/#6 |
| 9 | **The Figma walkthrough has never been completed.** Every attempt so far stopped on template choice (Component 47 is a price-sticker set; the frame Studio itself built has no `#` layers). All logic is verified against real data in isolation, but no end-to-end run has produced filled cards. | **open** | make one card with `#product`, `#offerprice`, `#mrp`, `#imageurl`, then run TESTING.md §2 |
| 10 | Groq free tier will cap very large multi-day pastes (see LIMITATIONS #6) | low | split by day, or Dev tier |
| 11 | vitest was discovering `.claude/worktrees/**` copies — 118 test files for ~45 real ones | fixed | `exclude` added to `vitest.config.ts` |

---

## 6 · Phase 2 implementation roadmap (plan only — nothing built)

Priority order as directed. Each item lists design, touch points, effort (S/M/L), dependencies.

**1. Per-designer API keys (M).** New table `figma_api_keys(id, employee_id,
key_hash, label, created_at, revoked_at)` + migration; keys hashed (SHA-256),
shown once on creation in Settings → Offer Intake; routes accept
`Bearer <personal key>` first, fall back to the workspace secret during
migration; change logs can then attribute pulls. Acceptance: revoke one key
without affecting others; old secret still works until removed.

**2. Mark as Designed / write-back (S-M).** First write route:
`POST /api/figma/campaign/:id/designed` setting `designed_at` + `designed_by`
(from the personal key). Additive migration on offer_campaigns. Plugin gains a
"Mark designed" button after a successful build; campaign card shows the state.
Depends on #1 for attribution (can ship before with workspace secret).

**3. Offer-changed detection (S).** `/offers` already returns `updatedAt` —
plugin stores it at load and on Refresh compares, showing a "changed since you
built" chip + one-click reload. No server work.

**4. Background removal, local AI (M).** Port the proven u2netp/onnxruntime
pipeline from Flyer Kit v2 `ui.html` into Studio as a build-time toggle
("Remove background from product images"). Needs model reachable: file-picker
fallback ships day 1; optional CORS patch on `/models/` (exists as
`cors-patch.md`) enables zero-touch loading. No per-image cost, on-device.

**5. Auto-export PNG (S).** Port `exportBuiltFrame()` from Flyer Kit v2
(2× PNG of the built frame, browser download). Toggle in Studio; later POST to
Cirqle for WhatsApp proofing (pairs with #2's write path).

**6. Watch mode (M).** Port Flyer Kit v2 watch loop: poll `/offers` every 60 s,
compare `updatedAt` for the armed campaign, rebuild from the remembered
template, chain #4/#5. Ceiling stays "Figma open with plugin running" —
documented platform limit.

**7. Private organization plugin (S, non-code).** Publish Studio as a Figma
**organization** private plugin (needs Figma Org plan) → one-click installs,
central updates, no per-machine manifest imports. Prereq: freeze plugin id.

**8. Retire Google Sheets (S, procedural).** After 2–3 clean weekly cycles on
Studio: per client, switch designers to the plugin, stop linking new sheets,
mark the shared script deprecated in GOOGLE_SHEETS_SETUP.md. Keep the
webhook infra dormant one month, then remove the per-client links. Both
pipelines read `buildOfferSheetRows`, so parity holds throughout —
no migration, only habit change.

**Sequencing:** 3 → 5 → 1 → 2 → 4 → 6 → 7 → 8 is the low-risk build order
(quick wins first, write-path after auth), but the priority list above is
honored if built strictly in order — nothing in it blocks anything above it
except #2's attribution, which degrades gracefully.

---

## 7 · Go / No-Go recommendation

> **Status after Phase 1.5 (25 Jul, evening):** unchanged and still accurate.
> Four defects were found and fixed since (§4b); all four were caught by
> testing rather than by a broken flyer. The single outstanding gate is
> still the human Figma walkthrough — Known Issue #9.

### **GO — for the API layer and everything automatable. Final production GO after the 10-minute Figma walkthrough.**

The complete live matrix is green in production: fail-closed auth (no-token
and wrong-token both 401), valid-token 200s, full campaign shape with prices,
MRPs, badges, category and bindings verified against real Sea Star data,
unknown-campaign 404, and response times well inside budget. The initial
NO-GO condition (undeployed routes) was resolved by merge `5a1e220` and
re-validated the same hour.

**The one remaining gate — human-only, ~10 minutes:** the Figma walkthrough
(TESTING.md steps 1–10), because development plugins execute only inside the
Figma desktop app. Expected result on today's data: 22 cards, all text filled,
1 real photo (Butterfly Facial Tissue), 21 gray placeholders — the placeholders
are correct behavior, not failures.

On a clean walkthrough, Phase 1 is closed and Phase 2 begins at item #1
(per-designer API keys), per the roadmap in section 6.
