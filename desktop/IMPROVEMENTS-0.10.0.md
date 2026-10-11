# Cirqle Desktop 0.10.0

## Implemented

1. Simplified toolbar: labelled Flyer, Add Pane and Layouts controls, one WhatsApp
   account selector, and a More menu for occasional actions. Account management
   stays available in its own menu; sharing and application panes are distinct.
2. Saved workspaces: built-in Cirqle + WhatsApp, Flyer work, Accounts and Cirqle
   only layouts; save/replace/remove up to 20 named layouts with pane proportions.
   Deleted accounts/tabs are skipped when restoring a saved layout.
3. Sharing feedback: choose the destination WhatsApp account before sharing;
   feedback names that account and distinguishes copying, paste attempts and
   attachment handoffs. Cancelling leaves the share unperformed. No auto-send.
4. Unsaved-work protection: live Flyer save state in pane headers and a warning
   before closing a dirty Flyer pane or quitting. The desktop also reads the
   existing hosted Flyer's status, so protection does not wait for deployment.
   Offer Studio source now reports dirty state explicitly for greater accuracy.
5. Small-window usability: readable minimum pane widths where the window permits,
   expand/restore on every pane, and a narrow-window hint. Expanding retains the
   other panes and their proportions. The final Cirqle close button is disabled.
6. Per-pane recovery: loading, offline, failed and unresponsive states; direct
   Retry controls, a safe local fallback page and retry of the failed page rather
   than resetting all panes. Cirqle, both Flyers, each WhatsApp account and browser
   tabs are tracked separately.
7. Easier installation/updates: update badge, progress and restart controls;
   guarded Install in Applications action; a separate signed/notarized release
   profile and automatic-update integration. Local unsigned builds continue to
   use manual download/install. Apple credentials and a signed published release
   are required before automatic delivery can be verified and activated.

## Verification

Desktop regression checks pass. UI smoke checks cover four panes at 900px and
1440px, browser address controls, close/expand/retry, layout saving, account-named
share feedback and restart action. The actual Electron smoke test verifies
startup, trusted IPC, saved-layout persistence, expansion/restoration, live Flyer
save feedback and cancellation of a dirty close. Offer Studio type checking and
12 existing save/sync policy tests pass. Cirqle source type checking passes when
excluding an already malformed generated `.next/dev/types/validator.ts`; the
default full typecheck is blocked by that unrelated generated development file.

These checks use isolated data or mocks. Staff WhatsApp attachment acceptance,
voice recording and a signed automatic-update rollout still require live checks.
The Offer Studio and receipt-dialog source edits must be deployed separately
for their enhanced browser-side integration; desktop fallback detection works
with the existing hosted Flyer status text.
