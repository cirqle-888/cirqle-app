# Cirqle Desktop

A thin Electron shell that puts **Cirqle** and **WhatsApp Web** side by side in one
window, with a one-tap **clipboard → Quick Capture** action. The workflow is fully
manual: read a message in the WhatsApp pane, copy it, and drop it into Cirqle.

WhatsApp Web works here because Electron loads `web.whatsapp.com` as a top-level page
(not an iframe), so the `X-Frame-Options` block that prevents embedding it in a normal
website does not apply — the same approach Rambox / Ferdi / WhatsApp Desktop use.

## Run (development)

```bash
cd desktop
npm install
# Point the left pane at your local Cirqle dev server:
npm run dev          # CIRQLE_URL=http://localhost:3000
# …or against production:
npm start            # uses https://app.cirqle.work
```

First run: the **WhatsApp pane shows a QR code** — scan it once from your phone
(WhatsApp → Linked devices). The session is persisted (`persist:whatsapp:default`),
so you stay logged in across restarts.

## Using it

- **Quick ▾ (toolbar):** everything people do every day in one menu, in the
  order staff actually use it — My Work, Tasks, Team Chat, Requests, Work Log,
  then *New request from clipboard*, *Search or jump anywhere*, *Prompt Studio
  beside*, *Record a payment*, clients and content, and the office pages. The
  same list is in the menu bar (**Quick**, where the shortcuts are: ⌘1 My Work,
  ⌘2 Tasks, ⌘3 Chat, ⌘4 Requests, ⌘5 Work Log, ⌘6 Clients, ⌘7 Social Calendar,
  ⌘0 Home), on the **menu-bar icon** and on the **Dock icon** (right-click).
  The list lives in one file, `src/main/quick-actions.js`.
- **My Work / Tasks / Chat (toolbar):** the three most-used pages, one click.
- **Prompt Studio (toolbar, or ⌘⇧P):** opens Prompt Studio in its own pane
  beside whatever you are working on — the client page, or the WhatsApp chat you
  are writing for. Click again to put it away.
- **Panes ▾ (toolbar):** add or close a pane — a second Cirqle page to compare,
  the Flyer app (Offer Studio, and a second Flyer pane), another WhatsApp
  account, a browser. **Client workspace** and saved **Layouts** are in this
  menu too. Drag a divider to resize; the last layout is remembered.
- **Capture:** copy text in the WhatsApp pane → **Quick ▾ → New request from
  clipboard** (or press **⌘⇧N** from anywhere, even another app). Cirqle's Quick
  Capture opens prefilled; review and confirm.
- **Copy/paste** uses the normal Edit menu shortcuts (⌘C / ⌘V).
- **Right-click menu (both panes):** a Chrome/Safari-style, context-aware menu —
  **Copy Image / Copy Image Address / Save Image to Downloads**, **Copy / Open Link
  in Browser**, and Cut/Copy/Paste/Select-All on editable fields. Right-clicking an
  image in the Cirqle pane also offers **Share Image to Linked WhatsApp**.
- **Common Downloads (⬇ toolbar button):** one shelf for every file saved from
  **either** pane — Cirqle reports/invoices/receipts *and* images/files saved from
  WhatsApp Web. Thumbnails for images, download progress, and per-item **Open /
  Show in Folder / Copy / Share to WhatsApp / Remove**. Files save to
  `~/Downloads/Cirqle/` and the list persists across restarts (like a browser).
  When a download starts, a little icon **flies to the ⬇ shelf button** (which
  then pulses) so you can see where it went.
- **Drag downloaded files out:** grab any item in the Downloads shelf and drag it
  straight into the WhatsApp pane's chat, into Finder, or onto any other app — a
  real OS file drag.
- **Offer Studio beside Cirqle (Panes ▾, or ⌘⇧O):** the flyer app as a
  real pane, not a browser tab — downloads land in the common shelf, right-click
  offers *Share Image to Linked WhatsApp*, and it shares Cirqle's login. It comes
  back when you reopen the window. Press **⌥⌘⇧O** (or choose *Offer Studio 2*
  in Panes ▾) for a **second Studio pane**: the sheet on
  one side, the offer list or another client's sheet on the other. The two
  navigate independently, and closing a split keeps its page for when you
  reopen it.
- **Compare two Cirqle pages (Panes ▾ → Duplicate Cirqle):** open a **second Cirqle page
  side-by-side** in the right pane (duplicates the current page; shares your
  login). Great for comparing/analysing two records at once. Click it again — or
  click a WhatsApp tab — to bring WhatsApp back.
- **Share a payment receipt to WhatsApp:** in Cirqle's receipt dialog the **Send to
  WhatsApp** split-button offers three actions (pick from the ▾ menu): *Copy image +
  open WhatsApp* (default — press ⌘V in the chat), *Send to WhatsApp (auto-paste)*,
  or *Download + reveal in Finder*. Set the default (and optionally force it) in
  **Cirqle → Settings → WhatsApp**.

## Build and publish the Mac app (free)

```bash
npm run dmg                    # → dist/Cirqle Desktop-<version>-arm64.dmg
bash scripts/publish-mac.sh    # → public download (see RELEASE.md)
```

The build is signed locally ("ad-hoc"), not with a paid Apple Developer ID, so
macOS asks each person once: open the app, choose **Done** on the warning, then
**System Settings → Privacy & Security → Open Anyway**. The same steps are on
the public page, `https://app.cirqle.work/download`.

**Updates:** the app checks `desktop/latest.json` on GitHub and shows an update
badge; the person downloads the new installer and replaces the app. Fully
automatic updates need a Developer ID (see RELEASE.md, "Signed automatic updates").

**Windows:** not built yet. The ~10% of staff not on Mac use Cirqle + WhatsApp Web in a
browser meanwhile. A Windows target can be added later from this same codebase
(`electron-builder --win nsis`).

## Files

- `src/main.js` — window, the two `WebContentsView`s, UA override, persistent WhatsApp
  session, layout + draggable splitter, clipboard → capture bridge, macOS Edit menu,
  the context-aware right-click menu (`wireContextMenu`), the common downloads model
  (`wireDownloads` on both sessions + persisted `downloads.json`) and its floating
  panel, the native file drag-out (`downloads:startDrag`), the download fly-to-shelf
  animation (`flyDownloadFx`), the 2nd-Cirqle compare pane (`createCirqle2`), and the
  receipt → WhatsApp share engine (`share:receipt`).
- `src/preload-cirqle.js` — relays captured text into the Cirqle page as the
  `cirqle:capture` event, and exposes `shareReceipt(dataUrl, filename, action)`.
- `src/preload-ui.js` — IPC surface for the toolbar / splitter / overlay / downloads panel.
- `src/host.html` — toolbar. `src/downloads.html` — the downloads shelf.
  `src/download-fx.html` — the fly-to-shelf animation overlay.
  `src/splitter.html` / `src/overlay.html` — drag-to-resize.

On the Cirqle side the bridge lives in `src/lib/desktop.ts` (`isDesktop()`, share
preference helpers); the receipt dialog is `src/components/cashbook/receipt-modal.tsx`
and the preference UI is in Settings → WhatsApp (`DesktopReceiptShareCard`).

## Desktop 0.9.2 audit fixes

Every visible pane has a labelled close button in the row below the toolbar.
Close Flyer Cirqle or its second pane directly using ×. Closing the last
non-Cirqle pane returns to Cirqle; the last Cirqle pane remains open.
WhatsApp account tabs scroll when space is tight. Closing a WhatsApp pane
keeps its linked account; removing an account remains a separate action.

Remote panes cannot invoke toolbar/account/download management actions.
WhatsApp uses a retry-only preload for the bundled error page. App navigation
is restricted to the configured Cirqle and Flyer origins, with other links
opening in the system browser. Download filenames cannot escape the downloads
folder, and receipt downloads accept PNG, JPEG or WebP with a size limit.
Clipboard history is collected only while the Cirqle window is focused.
Cold-start deep links wait for the window; update requests have a timeout.
Auto-paste reports whether the paste operation was attempted successfully,
not whether WhatsApp accepted or sent the image. Sending still requires review.

Builds remain unsigned, with manual installation. These fixes do not add offline
mode or an automatic installer/updater. The checks cover IPC sender boundaries,
download containment, pane close/hide behavior, and queued deep links.
