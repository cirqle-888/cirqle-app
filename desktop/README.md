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
  session, layout + draggable splitter, clipboard → capture bridge, macOS Edit menu.
- `src/preload-cirqle.js` — relays captured text into the Cirqle page as the
  `cirqle:capture` event.
- `src/preload-ui.js` — IPC surface for the toolbar / splitter / overlay.
- `src/host.html` — toolbar. `src/splitter.html` / `src/overlay.html` — drag-to-resize.
