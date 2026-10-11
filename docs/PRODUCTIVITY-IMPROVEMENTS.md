# Cirqle productivity and reliability improvements

Review date: 11 October 2026. This is based on the local source and isolated automated checks, not observed staff usage or a production database audit.

## Implemented in this pass

- Unexpected optional-table query failures now reach the dashboard error boundary instead of showing empty assignments/packages. The existing missing-table compatibility fallback remains.
- The dashboard uses the server's explicit admin flag. A missing designation no longer bypasses protected route checks or qualifies an employee for admin notifications. The role context defaults to employee access.
- Admin push notifications are sent only after successful inserts. Duplicate retries and failed writes no longer send repeat alerts.
- Standalone type checking and production builds use `tsconfig.typecheck.json`, which checks freshly generated production route types independently of development-server output. The editor/development server keeps its own route types.
- Command search respects alternative permissions, filters old favorites/history after access changes, and hides creation actions in read-only previews.
- Search matches existing navigation keywords as well as page names. For example, “Instagram calendar” finds Social.
- Invoice, client and advertising results link to their records. Cashbook links use the existing focus parameter; task links prefill the existing task search.
- Rapid searches cannot let an older response overwrite a newer one. Failed requests show a retry action while page navigation remains available.
- Task, invoice, quotation and cashbook creation shortcuts open their existing forms through `?new=true`. The parameter is consumed once and other URL filters are preserved.

## Recommended next work

These extend existing functionality. Priorities are engineering/product judgments; measure staff behavior before assigning savings estimates.

| Priority | Improvement | Existing foundation | Acceptance criteria |
| --- | --- | --- | --- |
| 1 | A role-specific daily action queue | Today's Focus, employee task lists, follow-ups, approvals | Each item explains what needs attention and opens the relevant action. Designers see pending work/contributions; accounts see collections and billing; managers see blocked work and approvals. Avoid another separate dashboard. |
| 1 | Named saved views | URL filters, favorites, workspace navigation | Save filter/sort/column choices as “My overdue work”, “Awaiting client”, or “Unpaid this month”; restore and share permitted views; prevent saved links from preserving revoked access. |
| 1 | Recoverable form drafts | Invoice navigation guard and offline queue infrastructure | Recover unsent task/request/quotation drafts after refresh or an interrupted session. Display last-save time. Scope drafts to employee and workspace; clear them on successful submission and account changes. Financial submission still requires server validation. |
| 1 | Complete record navigation | New invoice/client/project search links, existing task search and cashbook focus | Open a selected historical task or cashbook entry even when current date filters exclude it. Fetch the selected record through existing permission/scope checks; display its context without loading all historical records. |
| 2 | Preview and recovery for bulk actions | Task multi-select, assignment and status actions | Show affected record count before changing data; report partial failures; retry failed rows only. Add Undo for reversible actions where the server can enforce concurrency and permissions. |
| 2 | Reusable client/service task templates | Recurring tasks, service defaults, request promotion | Reuse brief sections, checklists, assignees and relative due dates. Preview the resulting tasks and avoid duplicate creation. Keep recurring schedules in the existing scheduler. |
| 2 | Quieter, actionable notifications | Existing notification/push system and duplicate suppression | Group repeated events, distinguish actionable from informational alerts, offer snooze where applicable, and deep-link to the pending action. Measure unread and ignored alerts. |
| 2 | Consistent list and form behavior | Shared toolbar, filters, empty states, modal overlay | Standardize save/pending/error states, keyboard focus, required-field messages and mobile actions across Tasks, Invoices, Cashbook and Quotations. Preserve filters and scroll after returning from a record. |
| 3 | Contextual keyboard help | Command palette and quick creation links | Show Cmd/Ctrl+K and supported actions where users can discover them; provide a keyboard guide; verify focus returns correctly after every dialog closes. |
| 3 | Smaller workflow components | Shared finance engine and existing extracted dashboard analytics | Extract one workflow at a time from large invoice/task/settings screens after interaction tests are in place. Preserve behavior; avoid broad cosmetic rewrites of money-related screens. |

## Status of the recommended work

Implemented 11 October 2026. No production schema change was made: every feature below
rides existing tables. `npm test` 2,412 passed / 2 skipped, `npm run typecheck` clean,
`npm run lint` 0 errors (2,098 warnings, below the pre-existing 2,099), `npm run build`
including the privacy gate passed.

| Priority | Improvement | Status | Where |
| --- | --- | --- | --- |
| 1 | Role-specific daily action queue | Done | `src/lib/dashboard/action-queue.ts`; wired through `dashboard/page.tsx` → `EmployeeDashboard`, reusing the existing `FocusCard`. Fixed the underlying data gap: invoices, requests and notifications were fetched behind `isAdmin`, so an accounts or approvals role got an empty dashboard. Notifications are the viewer's own mail and are now fetched for everyone; the non-admin billing queue selects counts and references only, no amount columns. |
| 1 | Named saved views | Done | `src/lib/saved-views/model.ts`, `components/ui/saved-views.tsx`. Stored in `employee_favorites` under `entity_type = 'saved_view'`, so no new table. Mounted on Invoices, Cashbook and Contributions — the three screens that already keep their filters in the URL. Gating moved to `canOpenHref`, which also closed a real hole: the sidebar's favourites list matched pins by exact href and therefore never gated any pin carrying a query string. |
| 1 | Recoverable form drafts | Done | `src/lib/drafts/` (+ `use-form-draft`), `components/ui/draft-recovery.tsx`. Adopted on new Task, new Request and new Quotation. Scoped to employee + workspace in the key *and* in the stored envelope, so a draft cannot resurface for another account; cleared on successful submission; last-save time shown. |
| 1 | Complete record navigation | Done | `src/lib/navigation/focus-record.ts`, `components/ui/focused-record-notice.tsx`. Cashbook's `?focus=` now distinguishes "hidden by your filters" (with a one-click Show it) from "not loaded", instead of returning early for both. Tasks gained `?task=<id\|number>`, resolved server-side through the same select and the same strip/visibility/unit pipeline as every other row — one record, not `?history=all`. |
| 2 | Preview and recovery for bulk actions | Done | `src/lib/bulk/outcome.ts`, `components/ui/bulk-outcome-bar.tsx`. Count confirmed before writing; partial failures reported with real numbers; retry re-runs only the refused rows. Two server-side fixes came with it: `serverBulkUpdateStatus` used to bail on the first failing 100-row chunk, leaving earlier chunks already applied while reporting total failure; `serverBulkAssignEmployees` used one blanket DELETE then one INSERT, so a failed insert left *every* selected task unassigned. **No Undo** — these tables carry no version or updated-at precondition, so an undo would blind-write the previous value and could discard a colleague's edit. That needs optimistic-concurrency checks on the per-row actions first. |
| 2 | Reusable client/service task templates | Done | `src/lib/templates/`. Brand onboarding is now one built-in template rather than its own code path, so every template gets the same server-computed preview and the same title-based skip rule. Relative due dates ("three days after the run"). Stored as JSON in `company_settings` — validated on every read and write — because this pass may not add a table; moving them to one later changes only the two accessors at the top of `templates/actions.ts`. Recurring schedules stay in `/api/cron/recurring-tasks`, untouched. |
| 2 | Quieter, actionable notifications | Done | `src/lib/notifications/digest.ts` + `snooze.ts`. Repeats of the same type *and destination* fold into one expandable line; the badge counts unread **actionable** notifications only (an allow-list of informational types, with anything unrecognised treated as actionable); snooze for an hour / tomorrow / a week; the panel states how much of the backlog has gone a week unread. The floating comms widget uses the same badge rule so two badges on one screen cannot disagree. **Snoozes are per device** — durable storage for them is one nullable `snoozed_until` column, which this pass could not add; the menu says so. |
| 2 | Consistent list and form behaviour | Partly done | Done: filters and scroll both survive a return from a record — `src/lib/lists/scroll-restore.ts` + `use-scroll-restore`, adopted on Tasks, Invoices, Cashbook, Quotations and Contributions, keyed per screen *and* per filter state so a position is never restored into a different list. Done: the shared save/pending/error vocabulary (`src/lib/forms/submit-state.ts`, `components/ui/form-status.tsx`) and named required-field messages, adopted on new Task and new Quotation — which fixed two silent failures, a quotation insert error that showed nothing at all and a task submit that left `addError` on screen with the button re-enabled. **Remaining:** converting the Invoices and Cashbook entry forms to the same vocabulary, and the mobile action-row review across all four. |
| 3 | Contextual keyboard help | Done | `src/lib/keyboard/shortcuts.ts`, `components/ui/keyboard-guide.tsx`. `?` anywhere (suppressed while typing) and a link in the command palette footer. The registry has a coverage test that fails if an entry points at a file that no longer handles a modifier, so the guide cannot drift. Focus restoration: `ModalOverlay` already trapped Tab and handed focus back; `ConfirmDialog` — some forty call sites — did neither, and now does, via `lib/hooks/use-dialog-focus`. |
| 3 | Smaller workflow components | Not started — blocked by its own precondition | The item says to extract "after interaction tests are in place", and the Interaction coverage section below records that they are not. Extracting workflows out of the invoice and task screens without them is exactly the broad rewrite of money-related screens the item warns against. |

### Not verified against a running app

Everything above is verified by the test suite, the type checker, the lint gate and a
production build. None of it has been exercised against a signed-in session: the local
dev server redirects to `/login`, and the development permission bypass deliberately does
not bypass authentication. The manual checks at the end of this document — an admin, a
staff role, an employee without a designation, and an access preview — are still needed,
in particular for the saved-view restore (a full document navigation, because the list
clients read their filters from `searchParams` only in `useState` initialisers), the
draft recovery banners, and the bulk partial-failure path.

## Reliability work still needed

### Database baseline and migration replay

CI documents that the versioned migrations cannot rebuild the current database from empty. A root `supabase-schema.sql` exists, but begins with destructive table drops and should not be treated as a verified current baseline.

1. Export a schema-only snapshot from the authoritative database using an authorized database connection.
2. Review functions, policies, grants and extension dependencies; exclude business records and secrets.
3. Establish a baseline and migration ledger without replaying historical alterations twice.
4. Restore into a disposable local/staging database and run RLS/grant checks plus seeded workflow tests.
5. Only then enable full database replay in CI. Never point reset/replay commands at production.

No production schema changes or database resets were performed in this pass. A verified baseline cannot be reconstructed from assumptions about the live schema.

### Interaction coverage

Add maintained browser tests for task creation/assignment, invoice creation/payment, payroll preview/finalization and access previews. Use seeded test data and verify both the displayed outcome and persisted result. Existing unit/static tests and the isolated search smoke checks do not establish live end-to-end correctness.

### Measurement

Record a baseline for time/clicks to find a record, create a task, prepare an invoice and record a payment. Track failed submissions, recovered drafts and repeated navigation. Set improvement targets after observing real workflows; avoid collecting form contents or financial details in analytics.

## Validation commands

Validated in this pass: 2,254 tests passed (2 skipped), standalone type checking passed, lint passed with existing warning debt, and the privacy gate passed. Production compilation passed after allowing the public Google Fonts downloads required by `next/font`. Isolated browser checks with mocked records passed for creation-link consumption, permission filtering, keyword search, overlapping requests, exact invoice navigation, and error/retry recovery. These checks did not submit live business records.

- `npm test` — business logic and regression suite.
- `npm run typecheck` — generates current route types, then checks application types.
- `npm run lint` — errors plus the existing warning budget.
- `npm run build` — privacy gate followed by production compilation.

For manual verification, test an admin, a staff role, an employee without a designation, and an admin access preview. In Cmd/Ctrl+K, check record links, rapid query changes, failed search/retry, revoked favorites, and each creation shortcut.
