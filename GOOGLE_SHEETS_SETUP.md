# Google Sheets Setup — Offer Campaign Sync

No Google Cloud Console needed. Uses Google Apps Script — completely free.

**You set this up ONCE for the whole workspace.** After that, adding a client = pasting their
Google Sheet link into Cirqle. No per-client script, no per-client deploy.

---

## How it works

You deploy **one** Apps Script Web App (a standalone script — not attached to any single sheet).
Cirqle sends it the offer data **plus the target sheet's ID and a shared secret**; the script opens
that sheet by ID and writes the "Offers" tab. One endpoint serves every client.

> **Important requirement:** the script runs *as the Google account that deploys it* ("Execute as: Me").
> That account must therefore have **edit access to every client's offer sheet**. The simplest setup:
> create all client offer sheets from **one company Google account**, and deploy this script from that
> same account. (If a sheet lives in another account, just share it — *Editor* — with the company account.)

---

## One-time setup (≈4 minutes)

### 1. Get the shared secret from Cirqle

Cirqle App → **Apps → Offer Intake → Shared sync script** → copy the **Shared secret**.
(If it's blank, click Save once with any URL, or it's generated the first time you connect.)

### 2. Create the script

Go to **[script.google.com](https://script.google.com)** → **New project**. Delete everything in the
editor and paste this, then replace `PASTE_SHARED_SECRET_HERE` with the secret from step 1.

> **Already deployed an older version?** Re-paste this script. It adds four things,
> all backward compatible — a client without categories still writes to "Offers":
>
> 1. A **fail-closed secret check**. The old version accepted every request when
>    `SECRET` was left unset.
> 2. A **`sheetName`** key, for a client whose categories write into separate tabs.
> 3. It **moves the written tab to position 1**. The Figma Google Sheets plugin
>    reads only the first tab, and a new spreadsheet still has an empty "Sheet1"
>    in front of it — which would sync a blank flyer with no error anywhere.
> 4. A **lock**, so two syncs landing on the same sheet at the same moment can't
>    interleave and leave stale rows.
>
> ⚠️ Paste this into the **shared** script only. Clients on their own bound script
> (`Advanced → per-client script override`) are sent no secret, so this version
> would reject their syncs — see *Legacy* below.

```javascript
// Cirqle — shared Offer sheet sync. One deployment serves all clients.
var SECRET = 'PASTE_SHARED_SECRET_HERE';

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = JSON.parse(e.postData.contents);

    // Reject anything that doesn't carry the shared secret.
    // This deployment is set to "Anyone", so the secret is the ONLY thing
    // standing between the open internet and the client's sheet. It therefore
    // fails CLOSED: an unreplaced placeholder or a blanked SECRET refuses every
    // request rather than accepting them all, which is what `if (SECRET && ...)`
    // used to do.
    if (!SECRET || SECRET === 'PASTE_SHARED_SECRET_HERE') {
      return json({ ok: false, error: 'Script not configured: SECRET is unset.' });
    }
    if (data.secret !== SECRET) {
      return json({ ok: false, error: 'Unauthorized' });
    }

    // Several clients often submit their lists within the same minute. Each one
    // writes to its OWN spreadsheet so the data can't mix, but this single
    // script runs them all — and two overlapping runs on the SAME sheet would
    // interleave clearContents() and setValues() and leave stale rows behind.
    // Serialising the write costs a second or two and removes that risk.
    if (!lock.tryLock(20000)) {
      return json({ ok: false, error: 'Another sync is still running. Try again in a moment.' });
    }

    // Open the target sheet by ID (sent by Cirqle from the client's Sheet link).
    // Falls back to the active sheet if this were ever bound to one.
    var ss = data.spreadsheetId
      ? SpreadsheetApp.openById(data.spreadsheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return json({ ok: false, error: 'No spreadsheet' });

    // Which tab to write. Cirqle sends `sheetName` when a client has offer
    // categories that write into separate tabs; without it everything goes to
    // "Offers" exactly as before.
    var sheetName = data.sheetName || 'Offers';
    var tab = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

    // The Figma Google Sheets plugin reads the FIRST tab of a spreadsheet and
    // ignores the rest. A brand-new sheet still has an empty "Sheet1" in front,
    // so inserting "Offers" behind it would sync a blank flyer with no error
    // anywhere. Force the tab we just wrote to the front.
    ss.setActiveSheet(tab);
    ss.moveActiveSheet(1);

    tab.clearContents();

    // Row 1 = headers (the stable Figma data contract). Rows 2+ = products.
    tab.getRange(1, 1, 1, data.headers.length).setValues([data.headers]);
    if (data.rows && data.rows.length > 0) {
      tab.getRange(2, 1, data.rows.length, data.rows[0].length).setValues(data.rows);
    }
    tab.autoResizeColumns(1, data.headers.length);
    SpreadsheetApp.flush();

    return json({ ok: true, rows: (data.rows || []).length, sheetUrl: ss.getUrl() });
  } catch (err) {
    return json({ ok: false, error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Click **Save** (name it e.g. `Cirqle Offers Sync`).

### 3. Deploy as a Web App

1. **Deploy** (top right) → **New deployment**
2. Gear ⚙ next to "Type" → **Web app**
3. **Execute as**: `Me` · **Who has access**: `Anyone`
4. **Deploy** → **Authorize access** → choose the **company Google account** → Allow
5. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`)

### 4. Connect it in Cirqle

Cirqle App → **Apps → Offer Intake → Shared sync script** → paste the Web app URL → **Save & connect**.
Status flips to **Connected**. Done — one time only.

---

## Adding a client (≈10 seconds each)

For each client card in **Offer Intake**:

1. Make sure the client's Google Sheet exists and is owned by / shared *Editor* with the company account.
2. Open it, copy the URL from the browser, paste it into the client's **Google Sheet link** field → **Save link**.
3. (Optional) **Run test sync now** to confirm.

That's it — no Apps Script per client. The next time the client saves their offer list, it syncs
automatically.

---

## Rotating the secret

If the secret is ever exposed: Cirqle → Shared sync script → regenerate → paste the new value into the
script's `SECRET` → **Deploy → Manage deployments → Edit ✎ → New version → Deploy**. (Same URL, no
re-connect needed in Cirqle.)

---

## Sheet columns written

Row 1 is the header row; data starts at row 2. These names and order are Cirqle's stable **Figma data
contract** — bind Figma components once, then refresh the Google Sheets plugin per offer. The editor's
**Copy table** / **Download CSV** use the exact same columns, so a manual paste is a safe fallback.

| Page Number | Display Order | Product | Weight | Offer Type | Offer Price | MRP | Offer Text | Badges | Image URL | Offer Title | Offer Date | Client | Price 1 | Price 2 |

`Image URL` must be a public direct image link so the Figma plugin can load it.

**Price 1 / Price 2** — ₹20.99 is also written as `Price 1 = 20`, `Price 2 = 99` so the paisa can be a
separate smaller Figma text layer; whole-rupee prices leave `Price 2` empty. These are appended after
the original 13, so existing bindings keep working.

---

## Legacy: per-client bound script (existing setups)

Clients set up before the shared script may have their own script URL (the old model). That still works —
a per-client **Advanced → per-client script override** URL takes precedence over the shared script for
that client. To migrate one to the shared model: clear its override, ensure its Sheet link is set, and
make sure the company account can edit that sheet.

<details>
<summary>Old per-client script (for reference)</summary>

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tab = ss.getSheetByName('Offers') || ss.insertSheet('Offers');
    tab.clearContents();
    tab.getRange(1, 1, 1, data.headers.length).setValues([data.headers]);
    if (data.rows && data.rows.length > 0) {
      tab.getRange(2, 1, data.rows.length, data.rows[0].length).setValues(data.rows);
    }
    tab.autoResizeColumns(1, data.headers.length);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: data.rows.length, sheetUrl: ss.getUrl() })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}
```
</details>

---

## Troubleshooting

- **"Unauthorized"** — the script's `SECRET` doesn't match Cirqle's. Copy the secret again and redeploy (new version).
- **"No spreadsheet" / can't open by ID** — the company account doesn't have edit access to that client's sheet. Share it *Editor* with the company account.
- **"HTTP 401" on sync** — redeploy as a **New deployment** (not edit) so permissions take effect; ensure "Who has access" = **Anyone**.
- **"Sheet sync timed out"** — the shared Web App URL is wrong. Re-copy from Deploy → Manage deployments.
- **"No Google Sheet linked"** — paste the client's Sheet link in their card.
