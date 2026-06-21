# Google Sheets Setup — Offer Campaign Sync

No Google Cloud Console needed. Uses Google Apps Script — completely free, runs inside each client's own Google Sheet.

---

## How it works

You paste a small script into each client's Google Sheet. The script creates a URL endpoint. Cirqle App sends the offer product data to that URL, and the script writes it into the sheet automatically.

Takes about **2 minutes per client** to set up.

---

## Setup steps (per client)

### 1. Open the client's Google Sheet

Open the Google Sheet you use for that client's offers.

---

### 2. Open Apps Script

In the sheet, click **Extensions → Apps Script**

A new tab opens with a script editor.

---

### 3. Paste the script

Delete everything in the editor and paste this:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet();

    // Get or create "Offers" tab
    var tab = sheet.getSheetByName("Offers");
    if (!tab) {
      tab = sheet.insertSheet("Offers");
    }

    // Clear existing content
    tab.clearContents();

    // Row 1: Column headers — kept as the FIRST row (no title row above it) so
    // tools that data-merge from a sheet (e.g. a Figma plugin) treat row 1 as
    // the header row. Offer date already travels per-product in the
    // "Offer Date" column, so a separate title row isn't needed.
    tab.getRange(1, 1, 1, data.headers.length).setValues([data.headers]);

    // Rows 2+: Product data
    if (data.rows && data.rows.length > 0) {
      tab.getRange(2, 1, data.rows.length, data.rows[0].length).setValues(data.rows);
    }

    // Auto-resize columns
    tab.autoResizeColumns(1, data.headers.length);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, rows: data.rows.length }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

Click **Save** (Ctrl+S / Cmd+S). Name the project anything, e.g. `Cirqle Offers Sync`.

---

### 4. Deploy as Web App

1. Click **Deploy** (top right) → **New deployment**
2. Click the gear icon ⚙ next to "Type" → select **Web app**
3. Set:
   - **Description**: `Cirqle Offers Sync`
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
4. Click **Deploy**
5. Click **Authorize access** → choose your Google account → Allow
6. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/AKfycb.../exec`)

---

### 5. Add the URL to Cirqle App

In Cirqle App → **Settings → Clients** → open the client → paste the Web App URL into the **Google Sheet Webhook URL** field → Save.

That's it. The next time the client saves their offer list, it will automatically appear in the "Offers" tab of their sheet.

---

## Sheet columns written

Row 1 is the header row (Product / Weight / Price 1 / Price 2 / MRP / Offer Text / Badge / Image URL / Offer Date); product data starts at row 2 — no separate title row, so the sheet is ready to use directly as a data-merge source (e.g. in a Figma plugin).

| Product | Weight | Price 1 | Price 2 | MRP | Offer Text | Badge | Image URL | Offer Date | Page |

---

## Updating an already-deployed client sheet

If a client's sheet was set up before 2026-06-21, its row 1 still has a "Cirqle Offers" title row above the headers. To fix it: open that sheet → **Extensions → Apps Script** → replace the script with the version above (Step 3) → **Deploy → Manage deployments → Edit (pencil) → New version → Deploy**. No need to generate a new Web App URL — the existing one in Cirqle App keeps working.

---

## Troubleshooting

**"Sheet sync failed (HTTP 401)"** — Re-deploy the script. When re-deploying, make sure to create a **New deployment** (not update existing) so the new permissions take effect.

**"Sheet sync timed out"** — The Apps Script URL may be wrong. Copy it again from the Deploy menu → Manage deployments.

**Data not updating** — Make sure "Who has access" is set to **Anyone** (not "Anyone with Google account"). Re-deploy if you changed this.

**"No Google Sheet webhook configured"** — The client's Webhook URL field in Cirqle App Settings is empty. Paste the Apps Script URL there.
