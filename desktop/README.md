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

- **Layout:** toolbar buttons or the **View** menu — `50/50`, `Cirqle 75`,
  `WhatsApp 75`, `Hide WhatsApp`, `Hide Cirqle`. Drag the divider to resize. The last
  layout is remembered.
- **Capture:** copy text in the WhatsApp pane → click **➕ New request from clipboard**
  (or press **⌘⇧N**). Cirqle's Quick Capture opens prefilled; review and confirm.
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
- **Compare two Cirqle pages (⧉ toolbar button):** open a **second Cirqle page
  side-by-side** in the right pane (duplicates the current page; shares your
  login). Great for comparing/analysing two records at once. Click it again — or
  click a WhatsApp tab — to bring WhatsApp back.
- **Share a payment receipt to WhatsApp:** in Cirqle's receipt dialog the **Send to
  WhatsApp** split-button offers three actions (pick from the ▾ menu): *Copy image +
  open WhatsApp* (default — press ⌘V in the chat), *Send to WhatsApp (auto-paste)*,
  or *Download + reveal in Finder*. Set the default (and optionally force it) in
  **Cirqle → Settings → WhatsApp**.

## Build an unsigned macOS app (free)

```bash
npm run dmg          # → dist/Cirqle Desktop-<version>.dmg
```

This is **unsigned** (no paid Apple Developer ID). Because of that, macOS Gatekeeper
blocks the first launch. Each user does this **once**:

- **Right-click** the app in Applications → **Open** → **Open**, or
- clear the quarantine flag:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Cirqle Desktop.app"
  ```

**Updates:** there is no auto-updater (auto-update needs signing). To update, build a
new `.dmg`, share it, and re-install over the top. The toolbar shows the version.

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
