#!/usr/bin/env bash
# Cirqle remediation verification.
#
# Mechanically checks the acceptance criteria in ANTIGRAVITY-PLAN.md and prints
# a per-task PASS / FAIL / MANUAL table. Static checks only: greps, file
# existence, build and test. Anything needing a live database or a running app
# is reported MANUAL for a human to confirm.
#
# Usage:  bash scripts/verify-remediation.sh [--skip-build]
# Exit:   0 if no FAIL, 1 otherwise.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

PASS=0; FAIL=0; MANUAL=0
declare -a ROWS

G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'

ok()   { PASS=$((PASS+1));   ROWS+=("${G}PASS${N}|$1|$2"); }
bad()  { FAIL=$((FAIL+1));   ROWS+=("${R}FAIL${N}|$1|$2"); }
man()  { MANUAL=$((MANUAL+1)); ROWS+=("${Y}MAN ${N}|$1|$2"); }

# absent <id> <label> <pattern> [paths...] -- passes when the pattern is NOT found
absent() {
  local id="$1" label="$2" pat="$3"; shift 3
  local paths=("$@"); [[ ${#paths[@]} -eq 0 ]] && paths=(src)
  local hits
  hits=$(grep -rEn "$pat" "${paths[@]}" 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  if [[ "$hits" == "0" ]]; then ok "$id" "$label"
  else bad "$id" "$label (found $hits)"; fi
}

# present <id> <label> <pattern> [paths...] -- passes when the pattern IS found
present() {
  local id="$1" label="$2" pat="$3"; shift 3
  local paths=("$@"); [[ ${#paths[@]} -eq 0 ]] && paths=(src)
  if grep -rEq "$pat" "${paths[@]}" 2>/dev/null; then ok "$id" "$label"
  else bad "$id" "$label"; fi
}

# gone <id> <label> <path> -- passes when the path does NOT exist
gone() {
  if [[ ! -e "$3" ]]; then ok "$1" "$2"; else bad "$1" "$2 (still present: $3)"; fi
}

# exists <id> <label> <path>
exists() {
  if [[ -e "$3" ]]; then ok "$1" "$2"; else bad "$1" "$2 (missing: $3)"; fi
}

echo
echo "  Cirqle remediation verification — $(date '+%Y-%m-%d %H:%M')"
echo "  ${D}$(pwd)${N}"
echo

# ── Phase 1: Security ────────────────────────────────────────────────────────

exists  DB-00  "DB state documented"                 docs/db-state.md
man     DB-00b "Live DB confirms RLS on all tables"  # requires production/staging access

if ls supabase/migrations/*rls_baseline* >/dev/null 2>&1; then
  f=$(ls supabase/migrations/*rls_baseline* | head -1)
  if grep -qi "enable row level security" "$f" && grep -qi "revoke all" "$f" && grep -qi "from anon" "$f"; then
    ok DB-01 "RLS baseline migration (enable + revoke anon)"
  else
    bad DB-01 "RLS baseline migration incomplete (needs ENABLE RLS + REVOKE ALL FROM anon)"
  fi
  if ls supabase/rollbacks/*rls_baseline* >/dev/null 2>&1; then
    ok DB-01b "RLS rollback script present"
  else
    bad DB-01b "RLS rollback script missing"
  fi
else
  bad DB-01  "RLS baseline migration missing"
  bad DB-01b "RLS rollback script missing"
fi
man DB-01c "Staging smoke test: Tasks/Invoices/Cashbook/Settings/intake all load"

if [[ -f scripts/check-rls.sql ]] || grep -q '"check:rls"' package.json 2>/dev/null; then
  ok DB-02 "CI guard against unsecured tables"
else
  bad DB-02 "CI guard against unsecured tables missing"
fi

absent SEC-01 "No raw form spread into employees write" \
  "\.(insert|update)\(form\)" "src/app/(dashboard)/dashboard/settings/actions.ts"
exists SEC-01b "Settings actions test exists" "src/app/(dashboard)/dashboard/settings/actions.test.ts"

absent SEC-02  "No 'isAdmin ?? true' fail-open"        "isAdmin \?\? true"
absent SEC-02b "No null-designation-implies-admin"     "designationId === null|\!designation\?\.id" src/lib
absent SEC-02c "No '|| !me' permission bypass"         "canView.*\|\| \!me|\|\| \!me.*canView"
absent SEC-02d "No 'isAdmin: !loadFailed' fallback"    "isAdmin: \!loadFailed"
exists SEC-02e "Permission check test exists"          "src/lib/permissions/check.test.ts"

if [[ -f src/lib/permissions/is-admin.ts ]]; then
  n=$(grep -rEn "is_admin === true" src/lib 2>/dev/null | grep -v '\.test\.' | wc -l | tr -d ' ')
  if [[ "$n" == "1" ]]; then ok SEC-03 "Single isAdmin definition"
  else bad SEC-03 "isAdmin computed in $n places (expected 1)"; fi
else
  bad SEC-03 "src/lib/permissions/is-admin.ts missing"
fi

if grep -qE "routePermissions|from '\.\./nav-sections'|from '@/lib/nav-sections'" src/lib/supabase/middleware.ts 2>/dev/null; then
  ok SEC-04 "Middleware derives routes from nav-sections"
else
  bad SEC-04 "Middleware still hand-declares ROUTE_PERMS"
fi

if [[ -f "src/app/(dashboard)/dashboard/advertising/actions/ai-actions.ts" ]]; then
  bad SEC-05a "ai-actions.ts still present and must be guarded (or deleted by ADV-01)"
else
  ok SEC-05a "ai-actions.ts removed"
fi
# Catalog: count exported actions still relying on "signed in" instead of a permission.
cat_f="src/app/(dashboard)/dashboard/catalog/actions.ts"
if [[ -f "$cat_f" ]]; then
  weak=$(grep -c "Not signed in" "$cat_f" 2>/dev/null | tr -d ' ')
  if [[ "$weak" == "0" ]]; then ok SEC-05b "Catalog writes require a permission"
  else bad SEC-05b "Catalog writes gated on mere sign-in ($weak sites)"; fi
else
  ok SEC-05b "catalog actions.ts absent"
fi
exists SEC-05c "Server-action guard checker" scripts/check-action-guards.mjs

present SEC-06a "escapeHtml helper in invoice renderer" "escapeHtml" src/lib/invoices/render-html.ts
present SEC-06b "Public invoice iframe sandboxed"       "sandbox=" "src/app/i/[token]/public-invoice-view.tsx"
exists  SEC-06c "Invoice render XSS test"               src/lib/invoices/render-html.test.ts

exists SEC-07a "Shared upload validation module" src/lib/uploads.ts
absent SEC-07b "Extension never taken from filename" "filename\.split\('\.'\)"

man SEC-08 "Rate limiting returns 429 under burst (needs running app)"

# ── Phase 2: Money ───────────────────────────────────────────────────────────

exists FIN-01a "Unified recordPayment module" src/lib/finance/record-payment.ts
# Requires the module to exist AND be the only payments-insert site (baseline has 0 hits
# because the write is phrased differently, so gate on the module existing first).
if [[ -f src/lib/finance/record-payment.ts ]]; then
  n=$(grep -rEn "from\('payments'\)[[:space:]]*\.?[[:space:]]*insert|\.insert\(.*payment" src \
      2>/dev/null | grep -v '\.test\.' | grep -v 'record-payment.ts' | wc -l | tr -d ' ')
  if [[ "$n" == "0" ]]; then ok FIN-01b "payments written only via record-payment"
  else bad FIN-01b "$n payment-insert site(s) outside record-payment"; fi
else
  bad FIN-01b "record-payment module missing, cannot be sole writer"
fi
exists FIN-01c "Orphan-payment reconciliation script" scripts/find-orphan-payments.sql

absent FIN-02a "Invoice client no longer deletes payments" \
  "from\('payments'\)\.delete" "src/app/(dashboard)/dashboard/invoices/invoices-client.tsx"
# Must name the guard explicitly, not merely mention 'void' somewhere in the module.
present FIN-02b "Paid-invoice delete refused with a reason" \
  "cannot delete|cannot be deleted|has recorded payments|invoice has payments" \
  "src/app/(dashboard)/dashboard/invoices"

# The status write must actually target salary_advances, on one line.
present FIN-03a "Advance marked repaid on generation" \
  "from\('salary_advances'\).*update|update\(\{[^}]*status: *'(repaid|partially_repaid)'" \
  "src/app/(dashboard)/dashboard/payroll"
if ls src/lib/payroll/*advance*.test.ts >/dev/null 2>&1 || \
   grep -rlq "advance" src/lib/payroll/*.test.ts 2>/dev/null; then
  ok FIN-03b "Advance deduction covered by a test"
else
  bad FIN-03b "No advance-deduction test"
fi

present FIN-05a "Bulk Import delete labelled honestly" \
  "Delete .*rows|requireTypedConfirmation" "src/app/(dashboard)/dashboard/import"
absent  FIN-05b "No native confirm in Bulk Import" \
  "window\.confirm|[^.a-zA-Z]confirm\(" "src/app/(dashboard)/dashboard/import"

present FIN-06a "Reconciliation page requires admin" \
  "requireAdmin|isAdmin" "src/app/(dashboard)/dashboard/cashbook/reconciliation/page.tsx"
# Baseline already contains generic 'disabled' props, so require the specific intent:
# either the recalculate handler is gone, or it is explicitly disabled/renamed.
rec_dir="src/app/(dashboard)/dashboard/cashbook/reconciliation"
if [[ ! -d "$rec_dir" ]]; then
  ok FIN-06b "Reconciliation toolkit removed"
elif grep -rEq "Data Repair" "$rec_dir" 2>/dev/null && \
     ! grep -rEq "fixMismatches|Force Recalculate All" "$rec_dir" 2>/dev/null; then
  ok FIN-06b "Force Recalculate removed; page renamed Data Repair"
elif grep -rEq "disabled=\{true\}|disabled$|RECALC_DISABLED" "$rec_dir" 2>/dev/null && \
     grep -rEq "Data Repair" "$rec_dir" 2>/dev/null; then
  ok FIN-06b "Force Recalculate disabled; page renamed Data Repair"
else
  bad FIN-06b "Force Recalculate still active / page not renamed"
fi

# ── Phase 3: Deletions ───────────────────────────────────────────────────────

for p in executive health forecast ai-center admin; do
  gone "ADV-01" "advertising/$p deleted" "src/app/(dashboard)/dashboard/advertising/$p"
done
gone ADV-01f "advertising AI stack deleted"     src/lib/advertising/ai
gone ADV-01g "duplicate Meta callback deleted"  src/app/api/auth/meta/callback
absent ADV-01h "No references to deleted ad pages" "/advertising/(executive|forecast|ai-center)"

absent ADV-02 "Google Ads option removed" "google_ads|Google Ads" "src/app/(dashboard)/dashboard/advertising"

gone CLEAN-01a "push.sh removed"                push.sh
gone CLEAN-01b "designer toolkit removed"       figma-plugin/cirqle-designer-toolkit
gone CLEAN-01c "toolkit zip removed"            figma-plugin/cirqle-designer-toolkit.zip
gone CLEAN-01d "portal mockup removed"          src/app/portal/mockup
gone CLEAN-01e "stub toast hook removed"        src/components/ui/use-toast.ts
gone CLEAN-01f "audit.js scratch file removed"  audit.js
gone CLEAN-01g "simulate.js scratch removed"    simulate.js
gone CLEAN-01h "verify_workflow.js removed"     verify_workflow.js
if git ls-files --error-unmatch figma-plugin/cirqle-studio/plugin/dist/code.js >/dev/null 2>&1; then
  bad CLEAN-01i "figma dist/ still tracked by git"
else
  ok CLEAN-01i "figma dist/ untracked"
fi

absent CLEAN-02 "Dead ?new=true quick actions removed" "new=true"

# ── Phase 4: UX ──────────────────────────────────────────────────────────────

exists UX-01a "Shared ConfirmDialog"        src/components/ui/confirm-dialog.tsx
absent UX-01b "No native confirm() anywhere" "window\.confirm|[^.a-zA-Z]confirm\(" src/app src/components
absent UX-02a "No blocking alert() anywhere" "[^.a-zA-Z]alert\("               src/app src/components
n=$(grep -rEn "<ToastContainer" src 2>/dev/null | wc -l | tr -d ' ')
if [[ "$n" == "1" ]]; then ok UX-02b "Single global ToastContainer"
else bad UX-02b "$n ToastContainer mounts (expected 1)"; fi
present UX-02c "Toasts announced to screen readers" "aria-live" src/components/ui

present UX-04 "Assignment creates a notification" \
  "notification" "src/app/(dashboard)/dashboard/tasks/actions.ts"

# ── Phase 5: Agreements ──────────────────────────────────────────────────────

absent  AGR-02a "Invalid PostgREST embed filter removed" \
  "\.eq\('calendar:social_calendars" src/lib/agreements
exists  AGR-02b "Agreements server test"    src/lib/agreements/server.test.ts
# analytics.ts already mentions effective_* in comments/types at baseline — require the
# filter to be applied to the retainer-row query itself.
if grep -Eq "\.(lte|gte|or|filter)\([^)]*effective_(from|to)" src/lib/agreements/analytics.ts 2>/dev/null \
   || grep -Eq "withinEffectiveWindow|filterEffective" src/lib/agreements/analytics.ts 2>/dev/null; then
  ok AGR-03a "Analytics filters retainer rows by effective window"
else
  bad AGR-03a "Analytics still sums all term rows (no effective-window filter)"
fi
exists  AGR-03b "Analytics test"            src/lib/agreements/analytics.test.ts
present AGR-04  "Pricing fields guarded on save" \
  "view_pricing" "src/app/(dashboard)/dashboard/agreements/actions.ts"
# The ordering bug: a later-sorting migration must re-assert the coverage-aware trigger.
last_cov=$(grep -rlie "coverage" supabase/migrations/*.sql 2>/dev/null | sort | tail -1)
last_phase=$(ls supabase/migrations/phase*.sql 2>/dev/null | sort | tail -1)
if [[ -n "$last_cov" && ( -z "$last_phase" || "$(basename "$last_cov")" > "$(basename "$last_phase")" ) ]]; then
  ok AGR-05 "Coverage migration sorts after legacy phase migrations"
else
  bad AGR-05 "Legacy phase migration still sorts after coverage (clobbers trigger on fresh DB)"
fi
man AGR-05b "Fresh-DB rebuild confirms coverage trigger installed"

# ── Global gates ─────────────────────────────────────────────────────────────

echo "  ${D}running tests…${N}"
if npm test >/tmp/cirqle-test.log 2>&1; then
  ok GATE-1 "npm test passes"
else
  bad GATE-1 "npm test fails (see /tmp/cirqle-test.log)"
fi

if [[ "$SKIP_BUILD" == "0" ]]; then
  echo "  ${D}running build…${N}"
  if npm run build >/tmp/cirqle-build.log 2>&1; then
    ok GATE-2 "npm run build passes"
  else
    bad GATE-2 "npm run build fails (see /tmp/cirqle-build.log)"
  fi
else
  man GATE-2 "build skipped (--skip-build)"
fi

exists GATE-3 "Implementation findings recorded" FINDINGS-DURING-IMPL.md

if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
  ok GATE-4 "Working tree clean"
else
  man GATE-4 "Working tree has uncommitted changes"
fi

# ── Report ───────────────────────────────────────────────────────────────────

echo
printf '  %-6s %-12s %s\n' "STATUS" "TASK" "CHECK"
printf '  %s\n' "──────────────────────────────────────────────────────────────────────"
for row in "${ROWS[@]}"; do
  IFS='|' read -r st id label <<< "$row"
  printf '  %-6b %-12s %s\n' "$st" "$id" "$label"
done

echo
echo "  ──────────────────────────────────────────────────────────────────────"
printf '  %bPASS %d%b   %bFAIL %d%b   %bMANUAL %d%b\n' "$G" "$PASS" "$N" "$R" "$FAIL" "$N" "$Y" "$MANUAL" "$N"
echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "  ${R}Not complete.${N} $FAIL check(s) failing."
  echo
  exit 1
fi
echo "  ${G}All automated checks pass.${N} $MANUAL item(s) still need human confirmation."
echo
exit 0
